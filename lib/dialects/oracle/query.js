'use strict';

var Utils = require('../../utils'),
    AbstractQuery = require('../abstract/query'),
    uuid = require('node-uuid'),
    sequelizeErrors = require('../../errors.js'),
    async = require('async'),
    util = require('util');

var now = function getDate() {
    var date = new Date(),
    dd = String(date.getDate()).padStart(2, '0'),
    mm = String(date.getMonth() + 1).padStart(2, '0'), //January is 0!
    yyyy = date.getFullYear(),
    hh = String(date.getHours()).padStart(2, '0'),
    min = String(date.getMinutes()).padStart(2, '0'),
    sg = String(date.getSeconds()).padStart(2, '0'),
    mili = String(date.getMilliseconds()).padStart(3, '0');
    return dd + '-' + mm + '-' + yyyy + ' ' + hh + ':' + min + ':' + sg + ':' + mili;
}

module.exports = (function() {
    var Query = function(connection, sequelize, options) {
        this.connection = connection;
        this.instance = options.instance;
        this.model = options.model;
        this.sequelize = sequelize;
        this.uuid = uuid.v4();
        this.options = Utils._.extend({
            logging: console.log,
            plain: false,
            raw: false
        }, options || {});

        this.checkLoggingOption();

        if (options && options.maxRows != null) {
            this.maxRows = options.maxRows;
        } else if (sequelize.options && sequelize.options.maxRows != null) {
            this.maxRows = sequelize.options.maxRows;
        } else {
            this.maxRows = 99999;
        }
        this.outFormat = options.outFormat || this.sequelize.connectionManager.lib.OBJECT;
        this.autoCommit = (options.autoCommit === false ? false : true);
        this.clobAttributes = options.clobAttributes;

    };

    Utils.inherit(Query, AbstractQuery);
    Query.prototype.run = function(sql) {
        var self = this;
        // this.sql = sql;
        if (sql.match(/^(SELECT|INSERT|DELETE)/)) {
            this.sql = sql.replace(/; *$/, '');
        } else {
            this.sql = sql;
        }

        this.sequelize.log('Executing (' + (this.connection.uuid || 'default') + '): ' + this.sql, this.options);

        var promise = new Utils.Promise(function(resolve, reject) {

            if (self.sql === 'START TRANSACTION;' ||
                self.sql === 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;'
            ) {
                if (self.options.transaction && self.options.transaction.options && self.options.transaction.options.autoCommitTransactionalOFF) {
                    self.connection.autoCommit = false;  
                } else {
                    self.connection.autoCommit = true;
                }
                resolve();
                return;
            } else if (self.sql === 'SET autocommit = 1;') {
                self.connection.autoCommit=true;
                resolve();
                return;
            } else if (self.sql === 'COMMIT;') {
                self.connection.commit(function(err, results, fields) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
                return;
            } else if (self.sql === 'ROLLBACK;') {
                self.connection.rollback(function(err, results, fields) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
                return;
            } else {
                if (self.autoCommit !== false) {
                    self.autoCommit = true;
                }

                self.options.bind = self.options.bind || [];
                var idTransaction = self.options.transaction && self.options.transaction.id ? self.options.transaction.id : self.uuid;

                var start = new Date();
                var hrstart = process.hrtime();
                self.sequelize.log(`[START Execution transaction(${idTransaction}) time]: `, now());

                self.connection.execute(self.sql, self.options.bind, {
                    maxRows: self.maxRows,
                    outFormat: self.outFormat,
                    autoCommit: self.connection.autoCommit == null || self.connection.autoCommit
                }, function(err, results, fields) {
                    // console.log("==================fuck==================");
                    // console.log(self.sql);
                    // console.log(results);
                    // console.error(err.message);

                    var end = new Date() - start;
                    var hrend = process.hrtime(hrstart);
                    self.sequelize.log(`[END Execution transaction(${idTransaction}) time]: %dms`, end)
                    self.sequelize.log(`[END Execution transaction(${idTransaction}) time (hr)]: %ds %dms`, hrend[0], hrend[1] / 1000000)
                    self.sequelize.log(`[END Execution transaction(${idTransaction}) time]: `, now());
                    
                    if (err) {
                        // console.log(self.sql);
                        // console.error(err.message);
                        err.sql = self.sql;

                        reject(self.formatError(err));
                    } else {
                        self.formatResults(results, (err, items) => {
                            if (err) {
                                return reject(err);
                            }
                            resolve(items);
                            // console.log('---------------------items-----------------------');
                            
                            // console.log(items);
                        });
                    }
                });
            }
        });

        return promise;
    };

    /**
     * High level function that handles the results of a query execution.
     *
     *
     * Example:
     *  query.formatResults([
     *    {
     *      id: 1,              // this is from the main table
     *      attr2: 'snafu',     // this is from the main table
     *      Tasks.id: 1,        // this is from the associated table
     *      Tasks.title: 'task' // this is from the associated table
     *    }
     *  ])
     *
     * @param {Array} data - The result of the query execution.
     */
    Query.prototype.formatResults = function(data, done) {
        let result = this.instance;
        let _this = this;

        // if (data && typeof data.rows === 'object' && typeof data.metaData === 'object' ) {


        //   var rows=[], drows=data.rows, dmeta=data.metaData
        //   var endRows=drows.length;
        //   var endMeta=dmeta.length;
        //   for (var i = 0; i < endRows; i++){
        //     var obj={}
        //     for(var j = 0 ; j < endMeta; j++){
        //        obj[dmeta[j].name]=drows[i][j];

        //     }
        //     rows.push(obj);
        //   }

        //   data={
        //     metaData: data.metaData,
        //     outBinds: data.outBinds,
        //     rows: rows,
        //     rowsAffected: data.rowsAffected
        //   };
        // }

        if (this.isInsertQuery(data)) {
            this.handleInsertQuery(data);
            // console.warn(data);
            if (!this.instance && data && data.outBinds && data.outBinds[this.getInsertIdField()] && data.outBinds[this.getInsertIdField()][0]) {
                result = data.outBinds[this.getInsertIdField()][0];
            }
        }

        if (this.isSelectQuery()) {
            result = this.handleSelectQuery(data.rows);

        } else if (this.isShowTablesQuery()) {
            result = this.handleShowTablesQuery(data.rows);
            // } else if (this.isDescribeQuery()) {
            //   result = {};

            //   data.forEach(function(_result) {
            //     result[_result.Field] = {
            //       type: _result.Type.toUpperCase(),
            //       allowNull: (_result.Null === 'YES'),
            //       defaultValue: _result.Default
            //     };
            //   });
            // } else if (this.isShowIndexesQuery()) {
            //   result = this.handleShowIndexesQuery(data);

            // } else if (this.isCallQuery()) {
            //   result = data[0];
            // } else if (this.isBulkUpdateQuery() || this.isBulkDeleteQuery() || this.isUpsertQuery()) {
            //   result = data.affectedRows;
        } else if (this.isVersionQuery()) {
            var drows = data.rows;
            var endRows = drows.length;
            for (var i = 0; i < endRows; i++) {
                if (drows[i].PRODUCT.indexOf('Database') >= 0) {
                    result = 'PRODUCT=' + drows[i].PRODUCT + ', VERSION=' + drows[i].VERSION + ', STATUS=' + drows[i].STATUS;
                }
            }
            // } else if (this.isForeignKeysQuery()) {
            //   result = data;
        } else if (this.isRawQuery()) {
            // MySQL returns row data and metadata (affected rows etc) in a single object - let's standarize it, sorta
            result = [data.rows, data];
        }

        if (this.isBulkDeleteQuery() || this.isBulkUpdateQuery()) {
            result = data.rowsAffected;
        }
        
        // console.log("==========xxxxxxxxxxxxxxxxxx===============")
        // console.log(data);
        // console.log(result);
        return done(null, result);

    };


    Query.prototype.formatError = function(err) {

        // 00942
        return new sequelizeErrors.DatabaseError(err);
    };

    AbstractQuery.prototype.handleInsertQuery = function(results, metaData) {
        if (this.instance) {
            // add the inserted row id to the instance
            var autoIncrementField = this.model.autoIncrementField,
                id = null;

            if (results && results.outBinds && results.outBinds[this.getInsertIdField()] && results.outBinds[this.getInsertIdField()][0]) {
                id = results.outBinds[this.getInsertIdField()][0];
            }

            this.instance[autoIncrementField] = id;
        }
    };

    Query.prototype.getInsertIdField = function() {
        return 'rid';
    };

    return Query;
})();