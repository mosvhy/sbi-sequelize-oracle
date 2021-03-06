'use strict';

var AbstractConnectionManager = require('../abstract/connection-manager')
  , ConnectionManager
  , Utils = require('../../utils')
  , Promise = require('../../promise')
  , sequelizeErrors = require('../../errors');

ConnectionManager = function(dialect, sequelize) {
  this.sequelize = sequelize;
  this.config = sequelize.config;
  this.dialect = dialect;
  this.connections = {};

  // We attempt to parse file location from a connection uri but we shouldn't match sequelize default host.
  if (this.sequelize.options.host === 'localhost') delete this.sequelize.options.host;

  try {
    this.lib = require(sequelize.config.dialectModulePath || 'sqlite3').verbose();
  } catch (err) {
    throw new Error('Please install sqlite3 package manually');
  }
};

Utils._.extend(ConnectionManager.prototype, AbstractConnectionManager.prototype);

ConnectionManager.prototype.getConnection = function(options) {
  var self = this;
  options = options || {};
  options.uuid = options.uuid || 'default';
  options.inMemory = ((self.sequelize.options.storage || self.sequelize.options.host || ':memory:') === ':memory:') ? 1 : 0;

  if (self.connections[options.inMemory || options.uuid]) return Promise.resolve(self.connections[options.inMemory || options.uuid]);

  return new Promise(function (resolve, reject) {
    self.connections[options.inMemory || options.uuid] = new self.lib.Database(self.sequelize.options.storage || self.sequelize.options.host || ':memory:', function(err) {
      if (err) {
        if (err.code === 'SQLITE_CANTOPEN') return reject(new sequelizeErrors.ConnectionError(err));
        return reject(new sequelizeErrors.ConnectionError(err));
      }
      resolve(self.connections[options.inMemory || options.uuid]);
    });
  }).tap(function (connection) {
    if (self.sequelize.options.foreignKeys !== false) {
      // Make it possible to define and use foreign key constraints unless
      // explicitly disallowed. It's still opt-in per relation
      connection.run('PRAGMA FOREIGN_KEYS=ON');
    }
  });
};

ConnectionManager.prototype.releaseConnection = function(connection, force) {
  if (connection.filename === ':memory:' && force !== true) return;

  if (connection.uuid) {
    connection.close();
    delete this.connections[connection.uuid];
  }
};

module.exports = ConnectionManager;
