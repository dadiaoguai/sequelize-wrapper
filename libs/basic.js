const
  common = require('../common/basic'),
  utils = require('../common/utils'),
  Op = require('sequelize').Op,
  queryMap = require('./queryMap'),
  _ = require('lodash'),
  findOrCreateOrUpdate = require('./findOrUpdateOrCreate'),
  userUpdate = require('./userUpdate'),
  pluralize = require('pluralize')

const queryRegStr = Object.keys(queryMap).map(k => k).join('|')
const regOr = new RegExp(`_or_(${queryRegStr})$`)
const regOrAnd = new RegExp(`_or_and_(${queryRegStr})$`)
const reg = new RegExp(`_(${queryRegStr})$`)

/*
 * 这是一个封装了 sequelize 处理的类, 简化了查询条件的格式, 简化了输出内容的格式
 * 使用方法: model = new Model('表名')
 */

class Model {
  constructor (models, model, user) {
    this.model = models[model]
    this.options = {include: []}
    this.attributes = Object.keys(this.model.attributes)
    this.associations = this.model.associations
    this.name = model
    this.user = user
    this.models = models
    this.args = {}
  }

  /*
   * 传入或者替换 where string
   * @param {object} opts
   *
   * @return {object}
   */
  opts (opts) {
    this.options = opts

    return this
  }

  /**
   * 传入待处理的字段, 通常是 request 中的参数
   * @param {object} wherestr 条件
   * @param {boolean} page 是否处理 limit 和 offset
   * @return {object}
   */
  where (wherestr, page = true) {
    if (wherestr.hasOwnProperty('limit') && page) {
      wherestr.limit = parseInt(wherestr.limit) || 20
    }
    if (wherestr.hasOwnProperty('offset') && page) {
      wherestr.offset = parseInt(wherestr.offset) || 0
    }
    this.args = wherestr

    this.options.where = whereHandler.call(this, wherestr)
    return this
  }

  /**
   * 设置或者添加 order
   * @param {array} orders, 支持 [[field,'desc']] 或者 [field,'desc'] 格式
   *
   * @return {object}
   */
  order (orders) {
    if (_.has(this.options, 'order')) {
      let mul = false

      for (let o in orders) {
        if (_.isArray(o)) {
          mul = true
          break
        }
      }

      mul ? orders.forEach(o => this.options.order.push(o)) : this.options.order.push(orders)
    } else {
      this.options.order = orders
    }

    return this
  }

  /**
   * 设置或者添加 group
   * @param {array|string} group 组
   *
   * @return {object}
   */
  group (group) {
    if (_.has(this.options, 'group')) {
      if (_.isArray(group)) {
        group.forEach(g => this.options.group.push(g))
      }
      if (_.isString(group)) {
        this.options.group.push(group)
      }
    } else {
      this.options.group = group
    }

    return this
  }

  /*
   * 设置想要获得字段, 支持计算字段和联结表字段
   * e.x: attr = ['$all','field1','field2','include.schema1.field1,field2','include.schema1.schema2.field1,field2'
   *  ,'include.schema3.$null?status_in=1,2&createdAt_or_gt=2017-05-01&updatedAt_or_lt=2017-05-20&required']
   * $all, 展示该表的所有字段
   * $null, 不展示该表的字段
   * include 中同一个表中的多个字段, 用,分隔,如果需要附加查询条件的话, ?xxx=xx&xx=xx 这样, 如果是内联结, 则最后一定是 required
   *
   * @param {array} attr
   *
   * @return {object}
   */
  attrs (attr) {
    attrFactory.call(this, attr)

    return this
  }

  /*
   * 添加属性
   */
  addAttrs (attrs) {
    if (_.isArray(attrs)) {
      if (!this.options.attributes) {
        this.options.attributes = {include: []}
        attrs.forEach(attr => this.options.attributes.include.push(attr))
      } else {
        attrs.forEach(attr => this.options.attributes.push(attr))
      }
    }

    return this
  }

  /*
   * 添加 include 属性
   */
  include (include) {
    this.options.include = include

    return this
  }

  /*
   * 添加事务
   */
  transaction (t) {
    this.options.transaction = t

    return this
  }

  /**
   * findOne
   * @param {boolean} existedRequired, 值是否允许为空
   * @param {boolean} toJSON, 是否返回 json 化数据
   * @param {any} t, 事务信标
   * @return {promise}
   */
  async one (existedRequired = true, toJSON = false, t) {
    // console.log(util.inspect(this.options, false, null))
    // if (config.cache && cache && this.model.constructor.name !== 'Cacher') {
    //   this.model = Cacher.model(this.name).ttl(ttl)
    // }
    if (t) {
      this.options.transaction = t
    }

    let obj = await this.model.findOne(this.options)

    if (existedRequired && !obj) {
      throw new Error(`${this.model.name} 中未查询到相关数据!`)
    }

    this.options = {include: []}

    return toJSON ? obj.toJSON() : obj
  }

  /**
   * findAll
   * @param {boolean} pagination, 是否携带 count, default = false
   * @param {boolean} toJSON, 是否返回json格式的数据
   * @param {integer} t, 事务信标
   * @return {promise}
   */
  async all (pagination = false, toJSON = true, t = null) {
    let objs
    // console.log(util.inspect(this.options, false, null))

    // if (config.cache && cache && this.model.constructor.name !== 'Cacher') {
    //   this.model = Cacher.model(this.name).ttl(ttl)
    // }

    if (t) {
      this.options.transaction = t
    }

    if (pagination) {
      objs = await this.model.findAndCount(this.options)
    } else {
      objs = await this.model.findAll(this.options)
    }

    this.options = {include: []}

    if (pagination) {
      return {objs: toJSON ? objs.rows.map(obj => obj.toJSON()) : objs.rows, count: objs.count}
    }
    return toJSON ? objs.map(obj => obj.toJSON()) : objs
  }


  /**
   * 更新数据
   * updatedUsr 部分可以在非 wpp 项目中删掉
   * @param {object} args, 待更新参数
   * @param {any} t, 事务信标
   * @param {object|array} includes, 涉及的子 model
   * @return {promise}
   */
  async update (args, t, includes) {
    let clearArgs = common.clear(args)
    let query, wherestr
    let updatedArgs = {}

    clearArgs = userUpdate.call(this, clearArgs, this.user, 'update')

    this.attributes.forEach(attr => {
      if (_.has(clearArgs, attr) && attr !== 'id') {
        updatedArgs[attr] = clearArgs[attr]
      }
    })

    Object.keys(clearArgs).forEach(field => {
      let v = clearArgs[field]

      if (field.startsWith('id') && reg.test(field)) {
        query = field.match(reg)[1]
        wherestr = {[queryMap[query].name]: queryMap[query].handler(v)}
      } else if (field === 'id') {
        wherestr = v
      }
    })

    _.has(this.options, 'where') ? this.options.where.id = wherestr : this.options.where = {id: wherestr}

    if (t) {
      this.options.transaction = t
    }

    let obj

    if (_.isObject(wherestr)) {
      obj =  this.model.update(updatedArgs, this.options)

      this.options = {include: []}

      return obj
    }
    
    obj = await this.model.findOne({
      where: {id: wherestr},
      transaction: t
    })

    if (!_.isEmpty(includes)) {
      for (let model of includes) {
        let includeArgs = args[model] || args[pluralize.plural(model)]

        if (!_.isEmpty(includeArgs)) {
          await findOrCreateOrUpdate.call(this, obj, model, includeArgs, t)
        }
      }
    }

    this.options = {include: []}

    return obj.update(updatedArgs, {transaction: t})
  }

  /**
   * 创建数据, 支持批量创建和单创建
   * updatedUsr 部分可以在非 wpp 项目中删掉
   * @param {object|array} args, 创建 model 所需的数据
   * @param {any} t, 事务信标
   * @param {array} includes, 相关数据的 model 名称
   * @return {promise}
   */
  async create (args, t, includes) {
    let [clearArgs] = [{}]

    if (_.isArray(args)) {
      clearArgs = []
      args.forEach(arg => {
        let container = {}

        Object.keys(arg).forEach(key => {
          if (this.attributes.includes(key) && !common.isEmpty(arg[key])) {
            container[key] = arg[key]
          }
        })

        clearArgs.push(container)
      })
    } else {
      Object.keys(args).forEach(key => {
        if (this.attributes.includes(key) && !common.isEmpty(args[key])) {
          clearArgs[key] = args[key]
        }
      })
    }

    clearArgs = userUpdate.call(this, clearArgs, this.user, 'create')

    let obj

    if (_.isArray(clearArgs)) {
      obj =  this.model.bulkCreate(clearArgs, {transaction: t})

      this.options = {include: []}

      return obj
    }

    if (clearArgs.hasOwnProperty('id')) {
      obj = await this.model.findOne({where: {id: clearArgs.id}, transaction: t})
    }

    if (obj) {
      let dataExist = 51

      throw new Error(dataExist)
    } else {
      obj = await this.model.create(clearArgs, {transaction: t})
    }

    if (!_.isEmpty(includes)) {
      for (let model of includes) {
        let includeArgs = args[model] || args[pluralize.plural(model)]

        if (!_.isEmpty(includeArgs)) {
          await findOrCreateOrUpdate.call(this, obj, model, includeArgs, t)
        }
      }
    }

    this.options = {include: []}

    return obj
  }

  /**
   * 查询目标是否存在, 如果不存在则创建, 支持批量
   * @param {object|array} args 条件范围
   * @param {any} t 事务标志
   * @return {object|array}
   */
  async findOrCreate (args, t) {
    let result

    if (_.isArray(args)) {
      result = []
      for (let arg of args) {
        let options = {}

        options.where = arg
        if (t) {
          options.transaction = t
        }
        let obj = await this.model.findOrCreate(options)

        result.push(obj[0])
      }
    } else if (_.isObject(args)) {
      let obj = await this.model.findOrCreate(args)

      result = obj[0]
    } else {
      throw new Error('参数 args 必须是数组或者对象')
    }
    return result
  }

  /**
   * 是否缓存查询
   * @param {integer} t 缓存时间
   *
   * @return {object}
   */
  // cacherfy (t = defaultDuration) {
  //   if (config.cache) {
  //     this.model = Cacher.model(this.name).ttl(t)
  //   }
  //
  //   return this
  // }

  /**
   * 设置使用者
   * @param {string} user user id
   * @return {Model}
   */
  setUser (user) {
    this.user = user
    return this
  }

}

/**
 * where 属性处理, 跳过 limit 和 offset, 支持> < 模糊匹配等
 * e.x: {a: 1,b: > 2,c: 3 2?fuzzyMatch}
 * account.wallet, 含有 '.', 会进入 include 处理程序
 * @param {object} obj 待处理的目标
 * @return {object}
 * @this Model
 */
function whereHandler (obj) {
  let result = {}

  Object.keys(obj).forEach(k => {
    if (this.attributes.some(field => k.startsWith(field))) {
      _queryField2where.call(this, result, k, obj[k])
    }
    if (k === 'limit' || k === 'offset') {
      return
    }
    if (k.match(/\.\w+/)) {
      includeHandler.call(this, k, obj[k])
    }
  })

  return result
}

/**
 * 处理查询条件字段, 将其转换成 sequleize 可识别的格式
 * 支持后缀为 _gt|gte|lt|lte....等
 *
 * @param {object} container, where 容器
 * @param {string} k, 字段参数
 * @param {string} v, 字段对应的值
 * @param {string} md, model 名称
 *
 * @return {object}
 * @this Model
 */
function _queryField2where (container, k, v, md) {
  let field, query

  if (reg.test(k) && !regOr.test(k) && !regOrAnd.test(k)) {
    field = k.replace(reg, '')
    if (md) { // 判断k是否在该表中
      if (!Object.keys(this.models[md].attributes).includes(field)) {
        return
      }
    } else {
      if (!this.attributes.includes(field)) {
        return
      }
    }

    query = k.match(reg)[1]
    if (container[field]) {
      let tempValue = container[field]

      container[field] = {[Op.or]: {}}
      container[field][Op.or][queryMap[query].name] = queryMap[query].handler(v)
      _.isObject(tempValue) ? _.assign(container[field][Op.or], tempValue) : container[field][Op.or][Op.eq] = tempValue
    } else {
      container[field] = {}
      container[field][queryMap[query].name] = queryMap[query].handler(v)
    }
  } else if (regOr.test(k)) {
    field = k.replace(regOr, '')
    if (!this.attributes.includes(field)) {
      return
    }
    query = k.match(regOr)[1]
    let x = {}

    x[field] = {}
    x[field][queryMap[query].name] = queryMap[query].handler(v)
    _.isArray(container[Op.or]) ? container[Op.pr].push(x) : container[Op.or] = [x]
  } else if (regOrAnd.test(k)) {
    field = k.replace(regOrAnd, '')
    if (!this.attributes.includes(field)) {
      return
    }
    query = k.match(regOrAnd)[1]
    let x = {}

    x[field] = {}
    x[field][queryMap[query].name] = queryMap[query].handler(v)
    if (_.isArray(container[Op.or])) {
      let condition = _.find(container[Op.or], i => _.has(i, Op.and))

      condition ? condition[Op.and].push(x) : container[Op.or].push({[Op.and]: [x]})
    } else {
      container[Op.or] = [{[Op.and]: [x]}]
    }
  } else if (this.attributes.includes(k) || md && Object.keys(this.models[md].attributes).includes(k)) {
    container[k] = v
  }
}

/**
 * 针对 include 表的 where 参数设置
 * 如果 include 里面有, 查询字段会置入 wherestr 中
 * 如果没有, 会新建一个 model
 * include 处理 2.0版
 *
 * @param {string} k, key
 * @param {string} v, value
 * @return {void}
 * @inner
 * @this Model
 */
function includeHandler (k, v) {
  let mds = k.split('.')
  let field = mds.pop()

  _includeModel.call(this, this.options.include, mds, field, v)
}

/**
 * 处理 request 中的 include 查询, 绑定 wherestring 参数
 * @param {array} include, wherestring 中的 include 对象
 * @param {array} mds, 嵌套的 libs 的名称
 * @param {string} field, 字段名称 ( 未处理过的 )
 * @param {string} v, 参数的值
 * @return {void}
 * @inner
 * @this Model
 */
function _includeModel (include, mds, field, v) {
  if (include.length === 0) {
    include.push(_includeModelFactory.call(this, {}, mds, field, v))
  } else {
    let includeModel = _.find(include, m => m.model.name === mds[0])

    if (includeModel) {
      let md = mds.shift()

      if (mds.length === 0) {
        if (!includeModel.where) {
          includeModel.where = {}
        }

        _queryField2where.call(this, includeModel.where, field, v, md)
      } else {
        if (!includeModel.include) {
          includeModel.include = []
        }
        _includeModel.call(this, includeModel.include, mds, field, v)
      }
    } else {
      include.push(_includeModelFactory.call(this, {}, mds, field, v))
    }
  }
}

/**
 * include 处理的辅助函数
 * @param {object} obj, include对象
 * @param {array} mds, model 的名称组
 * @param {string} field, 字段名称
 * @param {string} v, field 对应的值
 * @return {object}
 * @inner
 * @this Model
 */
function _includeModelFactory (obj, mds, field, v) {
  let md = mds.shift()
  let Field = field

  if (reg.test(field) && !regOr.test(field) && !regOrAnd.test(field)) {
    Field = field.replace(reg, '')
  } else if (regOr.test(field)) {
    Field = field.replace(regOr, '')
  } else if (regOrAnd.test(field)) {
    Field = field.replace(regOrAnd, '')
  }

  obj.model = this.models[md]
  if (mds.length === 0) {
    obj.attributes = ['id', Field]
    obj.where = {}
    _queryField2where.call(this, obj.where, field, v, md)
  } else {
    obj.attributes = ['id']
    let includeObj = {}

    obj.include = [includeObj]
    _includeModelFactory.call(this, includeObj, mds, field, v)
  }

  return obj
}

/**
 * 属性加工, 输入想要展示的字段, include.为嵌套字段, e.x: include.account.wallet.id,username&id=1&required
 * $all, 表示展示全部的字段
 * $null, 表示什么字段也不展示,
 * 可以添加计算字段
 *
 * @param {array} attrs, 所有的 include 的属性
 * @return {void}
 * @this Model
 */
function attrFactory (attrs) {
  let directAttrs = []
  let includeAttrs = []

  attrs.forEach(attr => {
    if (_.isString(attr) && attr.startsWith('include.')) {
      includeAttrs.push(attr.replace('include.', ''))
    } else {
      directAttrs.push(attr)
    }
  })

  if (directAttrs.includes('$all')) {
    if (directAttrs.length !== 1) {
      this.options.attributes = {include: []}
      directAttrs.filter(attr => attr !== '$all').forEach(attr => {
        this.options.attributes.include.push(attr)
      })
    }
  } else if (directAttrs.includes('$exclude')) {
    this.options.attributes = {exclude: directAttrs.filter(attr => attr !== '$exclude')}
  } else {
    this.options.attributes = directAttrs
  }

  includeAttrs.forEach(i => {
    nestHandler.call(this, this.options.include, i)
  })
}

/**
 * 辅助处理函数
 * 可以处理的 where 条件与 whereFactory 类似
 *
 * @param {array} include, include集合
 * @param {string} list, 每个 include 的详细属性
 * @return {void}
 * @this Model
 */
function nestHandler (include, list) {
  let attributes = list

  if (_.isString(list)) {
    attributes = list.split('.')
  }
  let md = attributes[0]

  let model = {
    model: this.models[md],
    include: []
  }
  let existModel = _.find(include, m => m.model.name === md)

  if (!existModel) {
    include.push(model)
  } else {
    model = existModel
    if (!model.include) {
      model.include = []
    }
  }

  attributes.shift()
  attributes.length > 1 ? nestHandler.call(this, model.include, attributes) : _nestModelFactory.call(this, model, attributes[0])
}

/**
 * 处理 include 的辅助函数, 帮助设置 include 中的 model 展示的 attributes
 * @param {object} model, model 对象
 * @param {string} v, 具体的 attributes 值
 * @return {void}
 * @this Model
 */
function _nestModelFactory (model, v) {
  let attrs = v.split('?')[0]

  if (/\?/.test(v)) {
    let args = v.split('?')[1]

    if (!model.where) {
      model.where = {}
    }
    args.split('&').forEach(arg => {
      let field, value

      [field, value] = arg.split('=')

      if (field === 'as') {
        model[field] = value
        return
      }
      if (arg !== 'required') {
        _queryField2where.call(this, model.where, field, value, model.model.name)
      }

    })

    args.includes('required') ? model.required = true : model.required = false
  }

  if (attrs === '$null') {
    model.attributes = []
  } else if (attrs.startsWith('$exclude:')) {
    attrs = attrs.replace('$exclude:', '').split(',')
    model.attributes = {exclude: attrs}
  } else if (attrs !== '$all') {
    model.attributes = attrs.split(',')
  } else if (model.attributes && model.attributes.length !== 0 && attrs === '$all') {
    delete model.attributes
  }
}

module.exports = Model
