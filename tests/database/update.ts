/* eslint-disable jest/require-top-level-describe, no-plusplus, jest/no-export */
import assert from 'assert'
import { DB } from '../../src'

export default function(this: { db: DB }) {
  test('should perform update', async () => {
    const table = 'Table6'
    await this.db.create(table, [
      {
        id: 0,
        boolField: true,
        stringField: 'test',
      },
      {
        id: 1,
        boolField: true,
        stringField: 'test',
      },
    ])
    {
      const row = await this.db.findOne(table, { where: { id: 0 } })
      assert.equal(row.boolField, true)
      assert.equal(row.stringField, 'test')
    }
    const changes = await this.db.update(table, {
      where: { id: [0, 1] },
      update: {
        boolField: false,
        stringField: 'newTest',
      },
    })
    assert.equal(changes, 2)
    assert.equal(typeof changes, 'number')
    {
      const row = await this.db.findOne(table, { where: { id: 0 } })
      assert.equal(row.boolField, false)
      assert.equal(row.stringField, 'newTest')
    }
  })

  test('should perform update (undefined/null)', async () => {
    const table = 'Table6'
    await this.db.create(table, [
      {
        id: 0,
        boolField: true,
        stringField: 'test',
      },
      {
        id: 1,
        boolField: true,
        stringField: 'test',
      },
    ])
    {
      const changes = await this.db.update(table, {
        where: { id: null },
        update: {
          boolField: false,
          stringField: 'newTest',
        },
      })
      assert.equal(changes, 0)
    }
    {
      const changes = await this.db.update(table, {
        where: { id: undefined},
        update: {
          boolField: false,
          stringField: 'newTest',
        },
      })
      assert.equal(changes, 2)
    }
    {
      const row = await this.db.findOne(table, { where: { id: 0 } })
      assert.equal(row.boolField, false)
      assert.equal(row.stringField, 'newTest')
    }
    {
      const row = await this.db.findOne(table, { where: { id: 1 } })
      assert.equal(row.boolField, false)
      assert.equal(row.stringField, 'newTest')
    }
  })

  test('should catch update errors', async () => {
    const table = 'Table6'
    try {
      await this.db.update(table, {
        where: { invalidField: 0 },
        update: {
          invalidField: 1
        },
      })
      assert(false)
    } catch (err) {
      assert(/Error: anondb error: Error: Unable to find row definition for key: "invalidField"/.test(err.toString()))
    }
  })

  test('should perform upsert', async () => {
    const table = 'Table6'
    {
      const changes = await this.db.upsert(table, {
        where: { id: 0 },
        create: {
          id: 0,
          boolField: true,
          stringField: 'test',
        },
        update: {},
      })
      assert.equal(changes, 1)
      const doc = await this.db.findOne(table, { where: { id: 0 } })
      assert.equal(doc.stringField, 'test')
    }
    {
      const changes = await this.db.upsert(table, {
        where: { id: 0 },
        create: {
          id: 0,
          boolField: true,
          stringField: 'test',
        },
        update: {
          boolField: false,
        },
      })
      assert.equal(changes, 1)
      const doc = await this.db.findOne(table, {
        where: { id: 0 },
      })
      assert.equal(doc.boolField, false)
    }
  })

  test('should not upsert if empty update', async () => {
    const table = 'Table6'
    {
      const changes = await this.db.upsert(table, {
        where: { id: 0 },
        create: {
          id: 0,
          boolField: true,
          stringField: 'test',
        },
        update: {},
      })
      assert.equal(changes, 1)
      const doc = await this.db.findOne(table, {
        where: { id: 0 },
      })
      assert.equal(doc.id, 0)
    }
    {
      const changes = await this.db.upsert(table, {
        where: { id: 0 },
        create: {
          id: 0,
          stringField: 'test2',
          boolField: false,
        },
        update: {},
      })
      assert.equal(changes, 0)
      const doc = await this.db.findOne(table, {
        where: { id: 0 },
      })
      assert.equal(doc.boolField, true)
    }
  })

  test('should catch upsert errors', async () => {
    const table = 'Table6'
    try {
      await this.db.upsert(table, {
        where: { invalidField: 0 },
        create: {
          invalidField: 1
        },
        update: {
          invalidField: 1
        },
      })
      assert(false)
    } catch (err) {
      assert(/Error: anondb error: Error: Unable to find row definition for key: "invalidField"/.test(err.toString()))
    }
  })
}
