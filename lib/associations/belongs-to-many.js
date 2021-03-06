'use strict';

var Utils = require('./../utils')
  , Helpers = require('./helpers')
  , _ = require('lodash')
  , Association = require('./base')
  , CounterCache = require('../plugins/counter-cache')
  , util = require('util');

var BelongsToMany = function(source, target, options) {
  Association.call(this);

  this.associationType = 'BelongsToMany';
  this.source = source;
  this.target = target;
  this.targetAssociation = null;
  this.options = options || {};
  this.sequelize = source.modelManager.sequelize;
  this.through = options.through;
  this.scope = options.scope;
  this.isMultiAssociation = true;
  this.isSelfAssociation = this.source === this.target;
  this.doubleLinked = false;
  this.as = this.options.as;

  if (this.as) {
    this.isAliased = true;

    if (Utils._.isPlainObject(this.as)) {
      this.options.name = this.as;
      this.as = this.as.plural;
    } else {
      this.options.name = {
        plural: this.as,
        singular: Utils.singularize(this.as)
      };
    }
  } else {
    this.as = this.target.options.name.plural;
    this.options.name = this.target.options.name;
  }

  this.combinedTableName = Utils.combineTableNames(
    this.source.tableName,
    this.isSelfAssociation ? (this.as || this.target.tableName) : this.target.tableName
  );

  if (this.through === undefined || this.through === true || this.through === null) {
    throw new Error('belongsToMany must be given a through option, either a string or a model');
  }

  if (!this.through.model) {
    this.through = {
      model: this.through
    };
  }

  /*
   * If self association, this is the target association - Unless we find a pairing association
   */
  if (this.isSelfAssociation) {
    if (!this.as) {
      throw new Error('\'as\' must be defined for many-to-many self-associations');
    }

    this.targetAssociation = this;
  }

  /*
   * Default/generated foreign/other keys
   */
  if (_.isObject(this.options.foreignKey)) {
    this.foreignKeyAttribute = this.options.foreignKey;
    this.foreignKey = this.foreignKeyAttribute.name || this.foreignKeyAttribute.fieldName;
  } else {
    if (!this.options.foreignKey) {
      this.foreignKeyDefault = true;
    }

    this.foreignKeyAttribute = {};
    this.foreignKey = this.options.foreignKey || _.camelizeIf(
      [
        _.underscoredIf(this.source.options.name.singular, this.source.options.underscored),
        this.source.primaryKeyAttribute
      ].join('_'),
      !this.source.options.underscored
    );
  }

  if (_.isObject(this.options.otherKey)) {
    this.otherKeyAttribute = this.options.otherKey;
    this.otherKey = this.otherKeyAttribute.name || this.otherKeyAttribute.fieldName;
  } else {
    if (!this.options.otherKey) {
      this.otherKeyDefault = true;
    }

    this.otherKeyAttribute = {};
    this.otherKey = this.options.otherKey || _.camelizeIf(
      [
        _.underscoredIf(
          this.isSelfAssociation ?
            Utils.singularize(this.as) :
            this.target.options.name.singular,
          this.target.options.underscored
        ),
        this.target.primaryKeyAttribute
      ].join('_'),
      !this.target.options.underscored
    );
  }

  /*
   * Find paired association (if exists)
   */
  _.each(this.target.associations, function(association) {
    if (association.associationType !== 'BelongsToMany') return;
    if (association.target !== this.source) return;

    if (this.options.through.model === association.options.through.model) {
      this.paired = association;
    }
  }, this);

  if (typeof this.through.model === 'string') {
    if (!this.sequelize.isDefined(this.through.model)) {
      this.through.model = this.sequelize.define(this.through.model, {}, _.extend(this.options, {
        tableName: this.through.model,
        indexes: {}, //we dont want indexes here (as referenced in #2416)
        paranoid: false  // A paranoid join table does not make sense
      }));
    } else {
      this.through.model = this.sequelize.model(this.through.model);
    }
  }

  if (this.paired) {
    if (this.otherKeyDefault) {
      this.otherKey = this.paired.foreignKey;
    }
    if (this.paired.otherKeyDefault) {
      // If paired otherKey was inferred we should make sure to clean it up before adding a new one that matches the foreignKey
      if (this.paired.otherKey !== this.foreignKey) {
        delete this.through.model.rawAttributes[this.paired.otherKey];
      }
      this.paired.otherKey = this.foreignKey;
      this.paired.foreignIdentifier = this.foreignKey;
      delete this.paired.foreignIdentifierField;
    }
  }

  if (this.through) {
    this.throughModel = this.through.model;
  }

  this.options.tableName = this.combinedName = (this.through.model === Object(this.through.model) ? this.through.model.tableName : this.through.model);

  this.associationAccessor = this.as;

  // Get singular and plural names, trying to uppercase the first letter, unless the model forbids it
  var plural = Utils.uppercaseFirst(this.options.name.plural)
    , singular = Utils.uppercaseFirst(this.options.name.singular);

  this.accessors = {
    get: 'get' + plural,
    set: 'set' + plural,
    addMultiple: 'add' + plural,
    add: 'add' + singular,
    create: 'create' + singular,
    remove: 'remove' + singular,
    removeMultiple: 'remove' + plural,
    hasSingle: 'has' + singular,
    hasAll: 'has' + plural
  };

  if (this.options.counterCache) {
    new CounterCache(this, this.options.counterCache !== true ? this.options.counterCache : {});
  }
};

util.inherits(BelongsToMany, Association);

// the id is in the target table
// or in an extra table which connects two tables
BelongsToMany.prototype.injectAttributes = function() {
  var self = this;

  this.identifier = this.foreignKey;
  this.foreignIdentifier = this.otherKey;

  // remove any PKs previously defined by sequelize
  _.each(this.through.model.rawAttributes, function(attribute, attributeName) {
    if (attribute.primaryKey === true && attribute._autoGenerated === true) {
      delete self.through.model.rawAttributes[attributeName];
      self.primaryKeyDeleted = true;
    }
  });

  var sourceKey = this.source.rawAttributes[this.source.primaryKeyAttribute]
    , sourceKeyType = sourceKey.type
    , sourceKeyField = sourceKey.field || this.source.primaryKeyAttribute
    , targetKey = this.target.rawAttributes[this.target.primaryKeyAttribute]
    , targetKeyType = targetKey.type
    , targetKeyField = targetKey.field || this.target.primaryKeyAttribute
    , sourceAttribute = _.defaults(this.foreignKeyAttribute, { type: sourceKeyType })
    , targetAttribute = _.defaults(this.otherKeyAttribute, { type: targetKeyType });

  if (this.primaryKeyDeleted === true) {
    targetAttribute.primaryKey = sourceAttribute.primaryKey = true;
  } else if (this.through.unique !== false) {
    var uniqueKey = [this.through.model.tableName, this.identifier, this.foreignIdentifier, 'unique'].join('_');
    targetAttribute.unique = sourceAttribute.unique = uniqueKey;
  }

  if (!this.through.model.rawAttributes[this.identifier]) {
    this.through.model.rawAttributes[this.identifier] = {
      _autoGenerated: true
    };
  }

  if (!this.through.model.rawAttributes[this.foreignIdentifier]) {
    this.through.model.rawAttributes[this.foreignIdentifier] = {
      _autoGenerated: true
    };
  }

  if (this.options.constraints !== false) {
    sourceAttribute.references = {
      model: this.source.getTableName(),
      key:   sourceKeyField
    };
    // For the source attribute the passed option is the priority
    sourceAttribute.onDelete = this.options.onDelete || this.through.model.rawAttributes[this.identifier].onDelete;
    sourceAttribute.onUpdate = this.options.onUpdate || this.through.model.rawAttributes[this.identifier].onUpdate;

    if (!sourceAttribute.onDelete) sourceAttribute.onDelete = 'CASCADE';
    if (!sourceAttribute.onUpdate) sourceAttribute.onUpdate = 'CASCADE';

    targetAttribute.references = {
      model: this.target.getTableName(),
      key:   targetKeyField
    };
    // But the for target attribute the previously defined option is the priority (since it could've been set by another belongsToMany call)
    targetAttribute.onDelete = this.through.model.rawAttributes[this.foreignIdentifier].onDelete || this.options.onDelete;
    targetAttribute.onUpdate = this.through.model.rawAttributes[this.foreignIdentifier].onUpdate || this.options.onUpdate;

    if (!targetAttribute.onDelete) targetAttribute.onDelete = 'CASCADE';
    if (!targetAttribute.onUpdate) targetAttribute.onUpdate = 'CASCADE';
  }

  this.through.model.rawAttributes[this.identifier] = _.extend(this.through.model.rawAttributes[this.identifier], sourceAttribute);
  this.through.model.rawAttributes[this.foreignIdentifier] = _.extend(this.through.model.rawAttributes[this.foreignIdentifier], targetAttribute);

  this.identifierField = this.through.model.rawAttributes[this.identifier].field || this.identifier;
  this.foreignIdentifierField = this.through.model.rawAttributes[this.foreignIdentifier].field || this.foreignIdentifier;

  if (this.paired && !this.paired.foreignIdentifierField) {
    this.paired.foreignIdentifierField = this.through.model.rawAttributes[this.paired.foreignIdentifier].field || this.paired.foreignIdentifier;
  }

  this.through.model.init(this.through.model.modelManager);

  Helpers.checkNamingCollision(this);

  return this;
};

BelongsToMany.prototype.injectGetter = function(obj) {
  var association = this;

  obj[this.accessors.get] = function(options) {
    options = association.target.__optClone(options) || {};

    var instance = this
      , through = association.through
      , scopeWhere
      , throughWhere;

    if (association.scope) {
      scopeWhere = _.clone(association.scope);
    }

    options.where = {
      $and: [
        scopeWhere,
        options.where
      ]
    };

    if (Object(through.model) === through.model) {
      throughWhere = {};
      throughWhere[association.identifier] = instance.get(association.source.primaryKeyAttribute);

      if (through && through.scope) {
        Object.keys(through.scope).forEach(function (attribute) {
          throughWhere[attribute] = through.scope[attribute];
        }.bind(this));
      }

      options.include = options.include || [];
      options.include.push({
        model: through.model,
        as: through.model.name,
        attributes: options.joinTableAttributes,
        association: {
          isSingleAssociation: true,
          source: association.target,
          target: association.source,
          identifier: association.foreignIdentifier,
          identifierField: association.foreignIdentifierField
        },
        required: true,
        where: throughWhere,
        _pseudo: true
      });
    }

    var model = association.target;
    if (options.hasOwnProperty('scope')) {
      if (!options.scope) {
        model = model.unscoped();
      } else {
        model = model.scope(options.scope);
      }
    }

    return model.findAll(options);
  };

  obj[this.accessors.hasSingle] = obj[this.accessors.hasAll] = function(instances, options) {
    var where = {};

    if (!Array.isArray(instances)) {
      instances = [instances];
    }

    options = options || {};
    options.scope = false;

    _.defaults(options, {
      raw: true
    });

    where.$or = instances.map(function (instance) {
      if (instance instanceof association.target.Instance) {
        return instance.where();
      } else {
        var $where = {};
        $where[association.target.primaryKeyAttribute] = instance;
        return $where;
      }
    });

    options.where = {
      $and: [
        where,
        options.where
      ]
    };

    return this[association.accessors.get](options).then(function(associatedObjects) {
      return associatedObjects.length === instances.length;
    });
  };

  return this;
};

BelongsToMany.prototype.injectSetter = function(obj) {
  var association = this;

  obj[this.accessors.set] = function(newAssociatedObjects, options) {
    options = options || {};
    var instance = this
      , sourceKey = association.source.primaryKeyAttribute
      , targetKey = association.target.primaryKeyAttribute
      , identifier = association.identifier
      , foreignIdentifier = association.foreignIdentifier
      , where = {};

    if (newAssociatedObjects === null) {
      newAssociatedObjects = [];
    } else {
      newAssociatedObjects = association.toInstanceArray(newAssociatedObjects);
    }

    where[identifier] = this.get(sourceKey);
    return association.through.model.findAll(_.defaults({
      where: where,
      raw: true,
    }, options)).then(function (currentRows) {
      var obsoleteAssociations = []
        , defaultAttributes = options
        , promises = []
        , unassociatedObjects;

      // Don't try to insert the transaction as an attribute in the through table
      defaultAttributes = _.omit(defaultAttributes, ['transaction', 'hooks', 'individualHooks', 'ignoreDuplicates', 'validate', 'fields', 'logging']);

      unassociatedObjects = newAssociatedObjects.filter(function(obj) {
        return !_.find(currentRows, function(currentRow) {
          return currentRow[foreignIdentifier] === obj.get(targetKey);
        });
      });

      currentRows.forEach(function(currentRow) {
        var newObj = _.find(newAssociatedObjects, function(obj) {
          return currentRow[foreignIdentifier] === obj.get(targetKey);
        });

        if (!newObj) {
          obsoleteAssociations.push(currentRow);
        } else {
          var throughAttributes = newObj[association.through.model.name];
          // Quick-fix for subtle bug when using existing objects that might have the through model attached (not as an attribute object)
          if (throughAttributes instanceof association.through.model.Instance) {
            throughAttributes = {};
          }

          var where = {}
            , attributes = _.defaults({}, throughAttributes, defaultAttributes);

          where[identifier] = instance.get(sourceKey);
          where[foreignIdentifier] = newObj.get(targetKey);

          if (Object.keys(attributes).length) {
            promises.push(association.through.model.update(attributes, _.extend(options, {
              where: where
            })));
          }
        }
      });

      if (obsoleteAssociations.length > 0) {
        var where = {};
        where[identifier] = instance.get(sourceKey);
        where[foreignIdentifier] = obsoleteAssociations.map(function(obsoleteAssociation) {
          return obsoleteAssociation[foreignIdentifier];
        });

        promises.push(association.through.model.destroy(_.defaults({
          where: where
        }, options)));
      }

      if (unassociatedObjects.length > 0) {
        var bulk = unassociatedObjects.map(function(unassociatedObject) {
          var attributes = {};

          attributes[identifier] = instance.get(sourceKey);
          attributes[foreignIdentifier] = unassociatedObject.get(targetKey);

          attributes = _.defaults(attributes, unassociatedObject[association.through.model.name], defaultAttributes);

          _.assign(attributes, association.through.scope);

          return attributes;
        }.bind(this));

        promises.push(association.through.model.bulkCreate(bulk, options));
      }

      return Utils.Promise.all(promises);
    });
  };

  obj[this.accessors.addMultiple] = obj[this.accessors.add] = function(newInstances, additionalAttributes) {
    // If newInstances is null or undefined, no-op
    if (!newInstances) return Utils.Promise.resolve();

    additionalAttributes = additionalAttributes || {};

    var instance = this
      , defaultAttributes = _.omit(additionalAttributes, ['transaction', 'hooks', 'individualHooks', 'ignoreDuplicates', 'validate', 'fields', 'logging'])
      , sourceKey = association.source.primaryKeyAttribute
      , targetKey = association.target.primaryKeyAttribute
      , identifier = association.identifier
      , foreignIdentifier = association.foreignIdentifier
      , options = additionalAttributes;

    newInstances = association.toInstanceArray(newInstances);

    var where = {};
    where[identifier] = instance.get(sourceKey);
    where[foreignIdentifier] = newInstances.map(function (newInstance) { return newInstance.get(targetKey); });

    _.assign(where, association.through.scope);

    return association.through.model.findAll(_.defaults({
      where: where,
      raw: true,
    }, options)).then(function (currentRows) {
      var promises = [];

      var unassociatedObjects = [], changedAssociations = [];
      newInstances.forEach(function(obj) {
        var existingAssociation = _.find(currentRows, function(current) {
          return current[foreignIdentifier] === obj.get(targetKey);
        });

        if (!existingAssociation) {
          unassociatedObjects.push(obj);
        } else {
          var throughAttributes = obj[association.through.model.name]
            , attributes = _.defaults({}, throughAttributes, defaultAttributes);

          if (_.any(Object.keys(attributes), function (attribute) {
            return attributes[attribute] !== existingAssociation[attribute];
          })) {
            changedAssociations.push(obj);
          }
        }
      });

      if (unassociatedObjects.length > 0) {
        var bulk = unassociatedObjects.map(function(unassociatedObject) {
          var throughAttributes = unassociatedObject[association.through.model.name]
            , attributes = _.defaults({}, throughAttributes, defaultAttributes);

          attributes[identifier] = instance.get(sourceKey);
          attributes[foreignIdentifier] = unassociatedObject.get(targetKey);

          _.assign(attributes, association.through.scope);

          return attributes;
        }.bind(this));

        promises.push(association.through.model.bulkCreate(bulk, options));
      }

      changedAssociations.forEach(function(assoc) {
        var throughAttributes = assoc[association.through.model.name]
          , attributes = _.defaults({}, throughAttributes, defaultAttributes)
          , where = {};
        // Quick-fix for subtle bug when using existing objects that might have the through model attached (not as an attribute object)
        if (throughAttributes instanceof association.through.model.Instance) {
          throughAttributes = {};
        }

        where[identifier] = instance.get(sourceKey);
        where[foreignIdentifier] = assoc.get(targetKey);

        promises.push(association.through.model.update(attributes, _.extend(options, {
          where: where
        })));
      });

      return Utils.Promise.all(promises);
    });
  };

  obj[this.accessors.removeMultiple] = obj[this.accessors.remove] = function(oldAssociatedObjects, options) {
    options = options || {};

    oldAssociatedObjects = association.toInstanceArray(oldAssociatedObjects);

    var where = {};
    where[association.identifier] = this.get(association.source.primaryKeyAttribute);
    where[association.foreignIdentifier] = oldAssociatedObjects.map(function (newInstance) { return newInstance.get(association.target.primaryKeyAttribute); });

    return association.through.model.destroy(_.defaults({
      where: where
    }, options));
  };

  return this;
};

BelongsToMany.prototype.injectCreator = function(obj) {
  var association = this;

  obj[this.accessors.create] = function(values, options) {
    var instance = this;
    options = options || {};
    values = values || {};

    if (Array.isArray(options)) {
      options = {
        fields: options
      };
    }

    if (association.scope) {
      _.assign(values, association.scope);
      if (options.fields) {
        options.fields = options.fields.concat(Object.keys(association.scope));
      }
    }

    // Create the related model instance
    return association.target.create(values, options).then(function(newAssociatedObject) {
      return instance[association.accessors.add](newAssociatedObject, _.omit(options, ['fields'])).return(newAssociatedObject);
    });
  };

  return this;
};

module.exports = BelongsToMany;
