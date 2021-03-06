'use strict';

var DataTypes = require('./data-types')
  , SqlString = require('./sql-string')
  , lodash = require('lodash')
  , parameterValidator = require('./utils/parameter-validator')
  , inflection = require('inflection')
  , dottie = require('dottie')
  , uuid = require('node-uuid')
  , deprecate = require('depd')('Utils');

var Utils = module.exports = {
  inflection: inflection,
  _: (function() {
    var _ = lodash;

    _.mixin({
      includes: function(str, needle){
        if (needle === '') return true;
        if (str === null) return false;
        return String(str).indexOf(needle) !== -1;
      },
      camelizeIf: function(string, condition) {
        var result = string;

        if (condition) {
          result = Utils.camelize(string);
        }

        return result;
      },
      underscoredIf: function(string, condition) {
        var result = string;

        if (condition) {
          result = inflection.underscore(string);
        }

        return result;
      },
      /*
       * Returns an array with some falsy values removed. The values null, "", undefined and NaN are considered falsey.
       */
      compactLite: function(array) {
        var index = -1,
          length = array ? array.length : 0,
          result = [];

        while (++index < length) {
          var value = array[index];
          if (typeof value === 'boolean' || value === 0 || value) {
            result.push(value);
          }
        }
        return result;
      },
      matchesDots: function (dots, value) {
        return function (item) {
          return dottie.get(item, dots) === value;
        };
      }
    });

    return _;
  })(),
  // Same concept as _.merge, but don't overwrite properties that have already been assigned
  mergeDefaults: function (a, b) {
    return this._.merge(a, b, function (objectValue, sourceValue) {
      // If it's an object, let _ handle it this time, we will be called again for each property
      if (!this._.isPlainObject(objectValue) && objectValue !== undefined) {
        return objectValue;
      }
    }, this);
  },
  lowercaseFirst: function (s) {
    return s[0].toLowerCase() + s.slice(1);
  },
  uppercaseFirst: function (s) {
    return s[0].toUpperCase() + s.slice(1);
  },
  spliceStr: function (str, index, count, add) {
    return str.slice(0, index) + add + str.slice(index + count);
  },
  camelize: function(str){
    return str.trim().replace(/[-_\s]+(.)?/g, function(match, c){ return c.toUpperCase(); });
  },
  format: function(arr, dialect) {
    var timeZone = null;
    // Make a clone of the array beacuse format modifies the passed args
    return SqlString.format(arr[0], arr.slice(1), timeZone, dialect);
  },
  formatNamedParameters: function(sql, parameters, dialect) {
    var timeZone = null;
    return SqlString.formatNamedParameters(sql, parameters, timeZone, dialect);
  },
  cloneDeep: function(obj, fn) {
    return lodash.cloneDeep(obj, function (elem) {
      // Preserve special data-types like `fn` across clones. _.get() is used for checking up the prototype chain
      if (elem && typeof elem.clone === 'function') {return elem.clone(); }
      // Unfortunately, lodash.cloneDeep doesn't preserve Buffer.isBuffer, which we have to rely on for binary data
      if (Buffer.isBuffer(elem)) { return elem; }

      return fn ? fn(elem) : undefined;
    });
  },

  /* Used to map field names in attributes and where conditions */
  mapOptionFieldNames: function(options, Model) {
    if (options.attributes) {
      options.attributes = options.attributes.map(function(attr) {
        // Object lookups will force any variable to strings, we don't want that for special objects etc
        if (typeof attr !== 'string') return attr;
        // Map attributes to aliased syntax attributes
        if (Model.rawAttributes[attr] && attr !== Model.rawAttributes[attr].field) {
          return [Model.rawAttributes[attr].field, attr];
        }
        return attr;
      });
    }

    if (options.where) {
      var attributes = options.where
        , attribute
        , rawAttribute;

      if (options.where instanceof Utils.and || options.where instanceof Utils.or) {
        attributes = undefined;
        options.where.args = options.where.args.map(function (where) {
          return Utils.mapOptionFieldNames({
            where: where
          }, Model).where;
        });
      }

      if (attributes) {
        for (attribute in attributes) {
          rawAttribute = Model.rawAttributes[attribute];
          if (rawAttribute && rawAttribute.field !== rawAttribute.fieldName) {
            attributes[rawAttribute.field] = attributes[attribute];
            delete attributes[attribute];
          }

          if (lodash.isPlainObject(attributes[attribute])) {
            attributes[attribute] = Utils.mapOptionFieldNames({
              where: attributes[attribute]
            }, Model).where;
          }

          if (Array.isArray(attributes[attribute])) {
            attributes[attribute] = attributes[attribute].map(function (where) {
              return Utils.mapOptionFieldNames({
                where: where
              }, Model).where;
            });
          }
        }
      }
    }
    return options;
  },

  /* Used to map field names in values */
  mapValueFieldNames: function (dataValues, fields, Model) {
    var values = {};

    fields.forEach(function(attr) {
      if (dataValues[attr] !== undefined && !Model._isVirtualAttribute(attr)) {
        // Field name mapping
        if (Model.rawAttributes[attr] && Model.rawAttributes[attr].field && Model.rawAttributes[attr].field !== attr) {
          values[Model.rawAttributes[attr].field] = dataValues[attr];
        } else {
          values[attr] = dataValues[attr];
        }
      }
    });

    return values;
  },
  argsArePrimaryKeys: function(args, primaryKeys) {
    var result = (args.length === Object.keys(primaryKeys).length);
    if (result) {
      Utils._.each(args, function(arg) {
        if (result) {
          if (['number', 'string'].indexOf(typeof arg) !== -1) {
            result = true;
          } else {
            result = (arg instanceof Date) || Buffer.isBuffer(arg);
          }
        }
      });
    }
    return result;
  },
  canTreatArrayAsAnd: function(arr) {
    return arr.reduce(function(treatAsAnd, arg) {
      if (treatAsAnd) {
        return treatAsAnd;
      } else {
        return !(arg instanceof Date) && ((arg instanceof Utils.and) || (arg instanceof Utils.or) || Utils._.isPlainObject(arg));
      }
    }, false);
  },

  combineTableNames: function(tableName1, tableName2) {
    return (tableName1.toLowerCase() < tableName2.toLowerCase()) ? (tableName1 + tableName2) : (tableName2 + tableName1);
  },

  singularize: function(s) {
    return inflection.singularize(s);
  },

  pluralize: function(s) {
    return inflection.pluralize(s);
  },

  removeCommentsFromFunctionString: function(s) {
    s = s.replace(/\s*(\/\/.*)/g, '');
    s = s.replace(/(\/\*[\n\r\s\S]*?\*\/)/mg, '');

    return s;
  },

  toDefaultValue: function(value) {
    if (typeof value === 'function') {
      var tmp = value();
      if (tmp instanceof DataTypes.ABSTRACT) {
        return tmp.toSql();
      } else {
        return tmp;
      }
    } else if (value instanceof DataTypes.UUIDV1) {
      return uuid.v1();
    } else if (value instanceof DataTypes.UUIDV4) {
      return uuid.v4();
    } else if (value instanceof DataTypes.NOW) {
      return Utils.now();
    } else {
      return value;
    }
  },

  /**
   * Determine if the default value provided exists and can be described
   * in a db schema using the DEFAULT directive.
   *
   * @param  {*} value Any default value.
   * @return {boolean} yes / no.
   */
  defaultValueSchemable: function(value) {
    if (typeof value === 'undefined') { return false; }

    // TODO this will be schemable when all supported db
    // have been normalized for this case
    if (value instanceof DataTypes.NOW) { return false; }

    if (value instanceof DataTypes.UUIDV1 || value instanceof DataTypes.UUIDV4) { return false; }

    if (lodash.isFunction(value)) {
      return false;
    }

    return true;
  },

  removeNullValuesFromHash: function(hash, omitNull, options) {
    var result = hash;

    options = options || {};
    options.allowNull = options.allowNull || [];

    if (omitNull) {
      var _hash = {};

      Utils._.forIn(hash, function(val, key) {
        if (options.allowNull.indexOf(key) > -1 || key.match(/Id$/) || ((val !== null) && (val !== undefined))) {
          _hash[key] = val;
        }
      });

      result = _hash;
    }

    return result;
  },

  inherit: function(SubClass, SuperClass) {
    if (SuperClass.constructor === Function) {
      // Normal Inheritance
      SubClass.prototype = new SuperClass();
      SubClass.prototype.constructor = SubClass;
      SubClass.prototype.parent = SuperClass.prototype;
    } else {
      // Pure Virtual Inheritance
      SubClass.prototype = SuperClass;
      SubClass.prototype.constructor = SubClass;
      SubClass.prototype.parent = SuperClass;
    }

    return SubClass;
  },


  stack: function _stackGrabber() {
    var orig = Error.prepareStackTrace;
    Error.prepareStackTrace = function(_, stack) { return stack; };
    var err = new Error();
    Error.captureStackTrace(err, _stackGrabber);
    var errStack = err.stack;
    Error.prepareStackTrace = orig;
    return errStack;
  },

  sliceArgs: function (args, begin) {
    begin = begin || 0;
    var tmp = new Array(args.length - begin);
    for (var i = begin; i < args.length; ++i) {
        tmp[i - begin] = args[i];
    }
    return tmp;
  },

  now: function(dialect) {
    var now = new Date();
    if (['postgres', 'sqlite'].indexOf(dialect) === -1) {
      now.setMilliseconds(0);
    }
    return now;
  },

  tick: function(func) {
    var tick = (global.hasOwnProperty('setImmediate') ? global.setImmediate : process.nextTick);
    tick(func);
  },

  // Note: Use the `quoteIdentifier()` and `escape()` methods on the
  // `QueryInterface` instead for more portable code.

  TICK_CHAR: '`',
  addTicks: function(s, tickChar) {
    tickChar = tickChar || Utils.TICK_CHAR;
    return tickChar + Utils.removeTicks(s, tickChar) + tickChar;
  },
  removeTicks: function(s, tickChar) {
    tickChar = tickChar || Utils.TICK_CHAR;
    return s.replace(new RegExp(tickChar, 'g'), '');
  },

  /*
   * Utility functions for representing SQL functions, and columns that should be escaped.
   * Please do not use these functions directly, use Sequelize.fn and Sequelize.col instead.
   */
  fn: function(fn, args) {
    this.fn = fn;
    this.args = args;
  },

  col: function(col) {
    if (arguments.length > 1) {
      col = this.sliceArgs(arguments);
    }
    this.col = col;
  },

  cast: function(val, type) {
    this.val = val;
    this.type = (type || '').trim();
  },

  literal: function(val) {
    this.val = val;
  },

  and: function(args) {
    this.args = args;
  },

  or: function(args) {
    this.args = args;
  },

  json: function(conditionsOrPath, value) {
    if (Utils._.isObject(conditionsOrPath)) {
      this.conditions = conditionsOrPath;
    } else {
      this.path = conditionsOrPath;
      if (value) {
        this.value = value;
      }
    }
  },

  where: function(attribute, comparator, logic) {
    if (logic === undefined) {
      logic = comparator;
      comparator = '=';
    }

    this.attribute = attribute;
    this.comparator = comparator;
    this.logic = logic;
  },

  validateParameter: parameterValidator,

  formatReferences: function (obj) {
    if (!lodash.isPlainObject(obj.references)) {
      deprecate('Non-object references property found. Support for that will be removed in version 4. Expected { references: { model: "value", key: "key" } } instead of { references: "value", referencesKey: "key" }.');
      obj.references = { model: obj.references, key: obj.referencesKey, deferrable: obj.referencesDeferrable };
      obj.referencesKey = undefined;
      obj.referencesDeferrable = undefined;
    }

    return obj;
  }
};

Utils.and.prototype._isSequelizeMethod =
Utils.or.prototype._isSequelizeMethod =
Utils.where.prototype._isSequelizeMethod =
Utils.literal.prototype._isSequelizeMethod =
Utils.cast.prototype._isSequelizeMethod =
Utils.fn.prototype._isSequelizeMethod =
Utils.col.prototype._isSequelizeMethod =
Utils.json.prototype._isSequelizeMethod = true;

Utils.fn.prototype.clone = function() {
  return new Utils.fn(this.fn, this.args);
};

Utils.Promise = require('./promise');
