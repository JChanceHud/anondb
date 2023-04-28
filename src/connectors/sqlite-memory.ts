/* eslint-disable no-underscore-dangle */
import initSqlJs from 'sql.js'
import AsyncLock from 'async-lock'
import {
  DB,
  WhereClause,
  DeleteManyOptions,
  FindManyOptions,
  FindOneOptions,
  UpdateOptions,
  UpsertOptions,
  TableData,
  // normalizeRowDef,
  constructSchema,
  Schema,
  TransactionDB,
} from '../types'
import { SQLEncoder } from '../helpers/sql'
import { loadIncluded } from '../helpers/shared'
import { execAndCallback } from '../helpers/callbacks'

export class SQLiteMemoryConnector extends DB {
  db: any

  schema: Schema = {}

  lock = new AsyncLock({ maxPending: 100000 })

  sqlEncoder: SQLEncoder

  constructor() {
    super()
    this.db = {} as any
    this.sqlEncoder = new SQLEncoder('sqlite')
  }

  async init() {
    const SQL = await initSqlJs({
      // locateFile: (file: string) => `https://sql.js.org/dist/${file}`,
    })
    this.db = new SQL.Database()
  }

  static async create(tables: TableData[]) {
    const connector = new this()
    await connector.init()
    await connector.createTables(tables)
    return connector
  }

  async create(collection: string, _doc: any | any): Promise<any> {
    return this.lock.acquire('write', async () =>
      this._create(collection, _doc),
    )
      .catch(err => {
        throw new Error(`anondb error: ${err}`)
      })
  }

  private async _create(collection: string, _doc: any | any): Promise<any> {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    const docs = [_doc].flat()
    if (docs.length === 0) return []
    const { sql, query } = this.sqlEncoder.createSql(table, docs)
    await this.db.exec(sql)
    if (Array.isArray(_doc)) {
      return this._findMany(collection, {
        where: query,
      })
    }
    return this._findOne(collection, {
      where: query,
    })
  }

  async findOne(collection: string, options: FindOneOptions) {
    return this.lock.acquire('read', async () =>
      this._findOne(collection, options),
    )
      .catch(err => {
        throw new Error(`anondb error: ${err}`)
      })
  }

  async _findOne(collection: string, options: FindOneOptions) {
    const [obj] = await this._findMany(collection, {
      ...options,
      limit: 1,
    })
    return obj === undefined ? null : obj
  }

  async findMany(collection: string, options: FindManyOptions) {
    return this.lock.acquire('read', async () =>
      this._findMany(collection, options),
    )
      .catch(err => {
        throw new Error(`anondb error: ${err}`)
      })
  }

  async _findMany(collection: string, options: FindManyOptions) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection}`)
    const sql = this.sqlEncoder.findManySql(table, options)
    const result = await this.db.exec(sql)
    if (result.length === 0) return []
    const [{ columns, values }] = result
    const models = [] as any[]
    for (const value of values) {
      const obj = {}
      for (const [index, column] of Object.entries(columns)) {
        obj[column as string] = value[index]
      }
      models.push(obj)
    }
    const { include } = options
    await loadIncluded(collection, {
      models,
      include,
      findMany: this._findMany.bind(this),
      table,
    })
    return models.map(d => this.sqlEncoder.parseDoc(table, d))
  }

  async count(collection: string, where: WhereClause) {
    return this.lock.acquire('read', async () => this._count(collection, where))
      .catch(err => {
        throw new Error(`anondb error: ${err}`)
      })
  }

  async _count(collection: string, where: WhereClause) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection}`)
    const sql = this.sqlEncoder.countSql(table, where)
    const result = await this.db.exec(sql)
    return result[0].values[0][0]
  }

  async update(collection: string, options: UpdateOptions) {
    return this.lock.acquire('write', async () =>
      this._update(collection, options),
    )
      .catch(err => {
        throw new Error(`anondb error: ${err}`)
      })
  }

  private async _update(collection: string, options: UpdateOptions) {
    const { where, update } = options
    if (Object.keys(update).length === 0) return this._count(collection, where)
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    const sql = this.sqlEncoder.updateSql(table, options)
    await this.db.exec(sql)
    return this.db.getRowsModified()
  }

  async upsert(collection: string, options: UpsertOptions) {
    return this.lock.acquire('write', async () =>
      this._upsert(collection, options),
    )
      .catch(err => {
        throw new Error(`anondb error: ${err}`)
      })
  }

  async _upsert(collection: string, options: UpsertOptions) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    const sql = this.sqlEncoder.upsertSql(table, options)
    await this.db.run(sql)
    return this.db.getRowsModified()
  }

  async delete(collection: string, options: DeleteManyOptions) {
    return this.lock.acquire('write', async () =>
      this._deleteMany(collection, options),
    )
      .catch(err => {
        throw new Error(`anondb error: ${err}`)
      })
  }

  private async _deleteMany(collection: string, options: DeleteManyOptions) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table "${collection}"`)
    const sql = this.sqlEncoder.deleteManySql(table, options)
    await this.db.run(sql)
    return this.db.getRowsModified()
  }

  async transaction(operation: (db: TransactionDB) => void, cb?: () => void) {
    return this.lock.acquire('write', async () =>
      this._transaction(operation, cb),
    )
      .catch(err => {
        throw new Error(`anondb error: ${err}`)
      })
  }

  // Allow only updates, upserts, deletes, and creates
  private async _transaction(
    operation: (db: TransactionDB) => void,
    onComplete?: () => void,
  ) {
    if (typeof operation !== 'function') throw new Error('Invalid operation')
    const sqlOperations = [] as string[]
    const onCommitCallbacks = [] as Function[]
    const onErrorCallbacks = [] as Function[]
    const onCompleteCallbacks = [] as Function[]
    if (onComplete) onCompleteCallbacks.push(onComplete)
    const transactionDB = {
      create: (collection: string, _doc: any) => {
        const table = this.schema[collection]
        if (!table)
          throw new Error(`Unable to find table ${collection} in schema`)
        const docs = [_doc].flat()
        if (docs.length === 0) return
        const { sql } = this.sqlEncoder.createSql(table, docs)
        sqlOperations.push(sql)
      },
      update: (collection: string, options: UpdateOptions) => {
        const table = this.schema[collection]
        if (!table)
          throw new Error(`Unable to find table ${collection} in schema`)
        if (Object.keys(options.update).length === 0) return
        sqlOperations.push(this.sqlEncoder.updateSql(table, options))
      },
      delete: (collection: string, options: DeleteManyOptions) => {
        const table = this.schema[collection]
        if (!table) throw new Error(`Unable to find table "${collection}"`)
        const sql = this.sqlEncoder.deleteManySql(table, options)
        sqlOperations.push(sql)
      },
      upsert: (collection: string, options: UpsertOptions) => {
        const table = this.schema[collection]
        if (!table) throw new Error(`Unable to find table "${collection}"`)
        const sql = this.sqlEncoder.upsertSql(table, options)
        sqlOperations.push(sql)
      },
      onCommit: (cb: Function) => {
        if (typeof cb !== 'function')
          throw new Error('Non-function onCommit callback supplied')
        onCommitCallbacks.push(cb)
      },
      onError: (cb: Function) => {
        if (typeof cb !== 'function')
          throw new Error('Non-function onError callback supplied')
        onErrorCallbacks.push(cb)
      },
      onComplete: (cb: Function) => {
        if (typeof cb !== 'function')
          throw new Error('Non-function onComplete callback supplied')
        onCompleteCallbacks.push(cb)
      },
    }
    await execAndCallback(
      async function(this: any) {
        await Promise.resolve(operation(transactionDB))
        // now apply the transaction
        try {
          const transactionSql = `BEGIN TRANSACTION;
        ${sqlOperations.join('\n')}
        COMMIT;`
          await this.db.exec(transactionSql)
        } catch (err) {
          await this.db.exec('ROLLBACK;')
          throw err
        }
      }.bind(this),
      {
        onSuccess: onCommitCallbacks,
        onError: onErrorCallbacks,
        onComplete: onCompleteCallbacks,
      },
    )
  }

  async close() {
    await this.db.close()
  }

  async closeAndWipe() {
    await this.transaction(db => {
      for (const [table,] of Object.entries(this.schema)) {
        db.delete(table as string, { where: {} })
      }
    })
    await this.close()
  }

  async createTables(tableData: TableData[]) {
    this.schema = constructSchema(tableData)
    const createTablesCommand = this.sqlEncoder.tableCreationSql(tableData)
    await this.db.exec(createTablesCommand)
  }
}
