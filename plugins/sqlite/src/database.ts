import { App, Database, makeArray, Tables } from 'koishi'
import sqlite from 'better-sqlite3'
import { resolve } from 'path'
import { queryHelper, logger, caster, TableCaster } from './utils'

export type TableType = keyof Tables

export interface Config {
  path?: string
}

function getTypeDefinition({ type }: Tables.Field) {
  switch (type) {
    case 'integer':
    case 'unsigned':
    case 'date':
    case 'time':
    case 'timestamp': return `INTEGER`
    case 'float':
    case 'double':
    case 'decimal': return `REAL`
    case 'char':
    case 'string':
    case 'text':
    case 'list':
    case 'json': return `TEXT`
  }
}

function getColumnDefinitionSQL(table: string, key: string, adapter: TableCaster) {
  const config = Tables.config[table]
  const { initial, nullable = initial === undefined || initial === null } = config.fields[key]
  let def = queryHelper.escapeId(key)
  if (key === config.primary && config.autoInc) {
    def += ' INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT'
  } else {
    const typedef = getTypeDefinition(config.fields[key])
    def += ' ' + typedef + (nullable ? ' ' : ' NOT ') + 'NULL'
    if (initial !== undefined && initial !== null) {
      def += ' DEFAULT ' + queryHelper.escape(adapter.dump({ [key]: initial })[key])
    }
  }
  return def
}

export interface ISqliteFieldInfo {
  name: string
  type: string
  notnull: number
  // eslint-disable-next-line @typescript-eslint/naming-convention
  dflt_value: string
  pk: boolean
}

class SqliteDatabase extends Database {
  public db: sqlite.Database

  sqlite = this

  dbAdapters: Record<string, TableCaster>

  constructor(public app: App, public config: Config) {
    super(app)
    this.dbAdapters = Object.create(null)
  }

  private syncTable(table: string) {
    const adapter = caster.createTableCaster(table)
    this.dbAdapters[table] = adapter

    const info = this._getTableInfo(table)
    // FIXME: register platform columns before database initializion
    // WARN: side effecting Tables.config
    const config = Tables.config[table]
    if (table === 'user') {
      new Set(this.app.bots.map(bot => bot.platform)).forEach(platform => {
        config.fields[platform] = { type: 'string', length: 63 }
        config.unique.push(platform)
      })
    }
    const keys = Object.keys(config.fields)
    if (info.length) {
      logger.info('auto updating table %c', table)
      const allKeys = [...keys, ...info.map(row => row.name)]
      for (const key of allKeys) {
        if (keys.includes(key) && info.some(({ name }) => name === key)) continue
        if (keys.includes(key)) {
          // Add column
          const def = getColumnDefinitionSQL(table, key, adapter)
          this.run(`ALTER TABLE ${queryHelper.escapeId(table)} ADD COLUMN ${def}`)
        } else {
          // Drop column
          this.run(`ALTER TABLE ${queryHelper.escapeId(table)} DROP COLUMN ${queryHelper.escapeId(key)}`)
        }
      }
    } else {
      logger.info('auto creating table %c', table)
      const defs = keys.map(key => getColumnDefinitionSQL(table, key, adapter))
      const constraints = []
      if (config.primary && !config.autoInc) {
        constraints.push(`PRIMARY KEY (${this._joinKeys(makeArray(config.primary))})`)
      }
      if (config.unique) {
        constraints.push(...config.unique.map(keys => `UNIQUE (${this._joinKeys(makeArray(keys))})`))
      }
      if (config.foreign) {
        constraints.push(
          ...Object.entries(config.foreign)
            .map(([key, [table, key2]]) =>
              `FOREIGN KEY (${queryHelper.escapeId(key)})
              REFERENCES ${queryHelper.escapeId(table)} (${queryHelper.escapeId(key2)})`,
            ),
        )
      }
      this.run(`CREATE TABLE ${queryHelper.escapeId(table)} (${[...defs, ...constraints].join(',')})`)
    }
  }

  async start() {
    this.db = sqlite(this.config.path === ':memory:' ? this.config.path : resolve(this.config.path))
    this.db.function('regexp', (pattern, str) => +new RegExp(pattern).test(str))
    // Synchronize database schemas
    for (const name in Tables.config) {
      this.syncTable(name)
    }
  }

  _joinKeys(keys?: string[]) {
    return keys ? keys.map(key => queryHelper.escapeId(key)).join(',') : '*'
  }

  run(sql: string, params: any = []) {
    logger.debug('SQL > %c', sql)
    try {
      return this.db.prepare(sql).run(params)
    } catch (e) {
      logger.warn('SQL Failed > %c', sql)
      throw e
    }
  }

  get(sql: string, params: any = []) {
    logger.debug('SQL > %c', sql)
    try {
      return this.db.prepare(sql).get(params)
    } catch (e) {
      logger.warn('SQL Failed > %c', sql)
      throw e
    }
  }

  all(sql: string, params: any = []) {
    logger.debug('SQL > %c', sql)
    try {
      return this.db.prepare(sql).all(params)
    } catch (e) {
      logger.warn('SQL Failed > %c', sql)
      throw e
    }
  }

  _getTables(): string[] {
    const rows = this.all(`SELECT name FROM sqlite_master WHERE type='table'`)
    return rows.map(({ name }) => name)
  }

  _getTableInfo(table: string): ISqliteFieldInfo[] {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    return this.all(`PRAGMA table_info(${queryHelper.escapeId(table)})`)
  }

  stop() {
    this.db.close()
  }
}

export default SqliteDatabase
