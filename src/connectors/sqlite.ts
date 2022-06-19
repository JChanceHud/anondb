/* eslint-disable no-underscore-dangle */
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
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
import {
  tableCreationSql,
  createSql,
  findManySql,
  countSql,
  updateSql,
  deleteManySql,
  upsertSql,
} from '../helpers/sql'
import { loadIncluded } from '../helpers/shared'
import { execAndCallback } from '../helpers/callbacks'

export class SQLiteConnector extends DB {
  db: any // Database<sqlite3.Database, sqlite3.Statement>

  config: {
    filename: string
  } & any

  schema: Schema = {}

  lock = new AsyncLock({ maxPending: 100000 })

  constructor(config: any /* ISqlite.Config */) {
    super()
    this.config = config
    this.db = {} as any
  }

  async init() {
    this.db = await open(this.config)
  }

  static async create(
    tables: TableData[],
    _config: any /* ISqlite.Config */ | string,
  ) {
    const config =
      typeof _config === 'string'
        ? {
            filename: _config,
            driver: sqlite3.Database,
          }
        : _config
    const connector = new this(config)
    await connector.init()
    await connector.createTables(tables)
    return connector
  }

  async create(collection: string, _doc: any | any): Promise<any> {
    return this.lock.acquire('write', async () =>
      this._create(collection, _doc),
    )
  }

  private async _create(collection: string, _doc: any | any): Promise<any> {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    const docs = [_doc].flat()
    if (docs.length === 0) return []
    const { sql, query } = createSql(table, docs)
    try {
      const { changes } = await this.db.run(sql)
      if (changes !== docs.length) {
        throw new Error('Failed to create document')
      }
    } catch (err) {
      console.log(sql)
      throw err
    }
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
  }

  async _findMany(collection: string, options: FindManyOptions) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection}`)
    const sql = findManySql(table, options)
    const models = await this.db.all(sql).catch((err: any) => {
      console.log(sql)
      throw err
    })
    const objectKeys = Object.keys(table.rowsByName).filter(key => {
      return table.rowsByName[key]?.type === 'Object'
    })
    if (objectKeys.length > 0) {
      // need to expand json objects
      // nested yuck!
      // TODO handle json parse errors
      for (const model of models) {
        for (const key of objectKeys) {
          // eslint-disable-next-line no-continue
          if (typeof model[key] !== 'string') continue
          Object.assign(model, {
            [key]: JSON.parse(model[key]),
          })
        }
      }
    }
    const { include } = options
    await loadIncluded(collection, {
      models,
      include,
      findMany: this._findMany.bind(this),
      table,
    })
    return models
  }

  async count(collection: string, where: WhereClause) {
    return this.lock.acquire('read', async () => this._count(collection, where))
  }

  async _count(collection: string, where: WhereClause) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection}`)
    const sql = countSql(table, where)
    const result = await this.db.get(sql)
    return result['COUNT(*)']
  }

  async update(collection: string, options: UpdateOptions) {
    return this.lock.acquire('write', async () =>
      this._update(collection, options),
    )
  }

  private async _update(collection: string, options: UpdateOptions) {
    const { where, update } = options
    if (Object.keys(update).length === 0) return this._count(collection, where)
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    const sql = updateSql(table, options)
    try {
      const result = await this.db.run(sql)
      return result.changes || 0
    } catch (err) {
      console.log(sql)
      throw err
    }
  }

  async upsert(collection: string, options: UpsertOptions) {
    return this.lock.acquire('write', async () =>
      this._upsert(collection, options),
    )
  }

  async _upsert(collection: string, options: UpsertOptions) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    const sql = upsertSql(table, options)
    try {
      const { changes } = await this.db.run(sql)
      return changes
    } catch (err) {
      console.log(sql)
      throw err
    }
  }

  async delete(collection: string, options: DeleteManyOptions) {
    return this.lock.acquire('write', async () =>
      this._deleteMany(collection, options),
    )
  }

  private async _deleteMany(collection: string, options: DeleteManyOptions) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table "${collection}"`)
    const sql = deleteManySql(table, options)
    const { changes } = await this.db.run(sql)
    return changes || 0
  }

  async transaction(operation: (db: TransactionDB) => void, cb?: () => void) {
    return this.lock.acquire('write', async () =>
      this._transaction(operation, cb),
    )
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
        const { sql } = createSql(table, docs)
        sqlOperations.push(sql)
      },
      update: (collection: string, options: UpdateOptions) => {
        const table = this.schema[collection]
        if (!table)
          throw new Error(`Unable to find table ${collection} in schema`)
        if (Object.keys(options.update).length === 0) return
        sqlOperations.push(updateSql(table, options))
      },
      delete: (collection: string, options: DeleteManyOptions) => {
        const table = this.schema[collection]
        if (!table) throw new Error(`Unable to find table "${collection}"`)
        const sql = deleteManySql(table, options)
        sqlOperations.push(sql)
      },
      upsert: (collection: string, options: UpsertOptions) => {
        const table = this.schema[collection]
        if (!table) throw new Error(`Unable to find table "${collection}"`)
        const sql = upsertSql(table, options)
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

  async createTables(tableData: TableData[]) {
    this.schema = constructSchema(tableData)
    const createTablesCommand = tableCreationSql(tableData)
    await this.db.exec(createTablesCommand)
  }
}
