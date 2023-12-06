import { promises as fs, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as parser from '@babel/parser'
import traverse1, { Binding, NodePath, Scope, Visitor } from '@babel/traverse'
import generator1, { GeneratorOptions } from '@babel/generator'
import { codeFrameColumns } from '@babel/code-frame'
import template1 from '@babel/template'
import * as t from '@babel/types'
import { isEmpty } from 'lodash-es'

/** @type {generator1} */
const generator = generator1?.default || generator1
/** @type {traverse1} */
const traverse = traverse1?.default || traverse1
/** @type {template1} */
const template = template1?.default || template1

if (typeof window !== 'undefined')
  // eslint-disable-next-line no-global-assign
  global = window

let globalState = {
  objectVariables: {}, // 所有对象变量
  decryptFnList: [], // 解密函数列表
}

function handleError(error, rawCode) {
  if (error instanceof SyntaxError) {
    const codeFrame = codeFrameColumns(rawCode, {
      start: {
        line: error.loc.line,
        column: error.loc.column + 1,
      },
    }, {
      highlightCode: true,
      message: error.message,
    })

    console.error(codeFrame)
  }
}

export class Deob {
  /**
   *
   * @constructor
   * @param {string} rawCode - 原始代码
   * @param {object} [options] -  选项
   * @param {string} [options.dir] - 输出目录
   * @param {boolean} [options.isWriteFile] - 是否写入文件
   * @param {GeneratorOptions} [options.opts]
   * @param {boolean} [options.isLog] - 是否输出日志
   * @throws {Error} 请载入js代码
   */
  constructor(rawCode, options = {}) {
    if (!rawCode)
      throw new Error('请载入js代码')
    console.clear()

    /** @type {string} */
    this.rawCode = rawCode

    /** @type {GeneratorOptions} */
    this.opts = options.opts || {
      minified: false,
      jsescOption: { minimal: true },
      compact: false,
      comments: true,
    }

    this.dir = options.dir ?? '.'
    this.isWriteFile = options.isWriteFile ?? false
    this.isLog = options.isLog ?? true
    this.throwWithEval = options.throwWithEval ?? false

    globalState = {
      objectVariables: {},
      decryptFnList: [],
    }

    try {
      this.ast = parser.parse(rawCode, { sourceType: 'script' })
    }
    catch (error) {
      console.error('代码初始化解析有误!')

      handleError(error, rawCode)
      throw new Error(`代码初始化解析有误! ${error}`)
    }
  }

  log(...args) {
    this.isLog && console.log(...args)
  }

  get code() {
    const code = generator(this.ast, this.opts).code
    return code
  }

  getCode(opts) {
    const code = generator(this.ast, opts || this.opts).code
    return code
  }

  /**
   * 当执行替换(replace,rename等)操作时,需要执行一次更新以获取最新状态 ast
   */
  reParse() {
    const jscode = generator(this.ast, this.opts).code

    try {
      this.ast = parser.parse(jscode, { sourceType: 'script' })
    }
    catch (error) {
      // eslint-disable-next-line node/prefer-global/process
      if (!process.browser) {
        writeFileSync(path.join(this.dir, `errorCode.js`), jscode)
        this.log(`生成的错误代码请到 ${this.dir}/errorCode.js 查看`)
      }

      handleError(error, jscode)
      throw new Error(`代码替换有误,解析失败! 请到控制台中查看 ${error}`)
    }
  }

  /**
   * 记录解析后生成的代码 方便调试查看
   * @param {string} fileName
   * @param {number} i
   */
  async record(fileName, i) {
    if (this.isWriteFile) {
      await fs.writeFile(
        path.join(this.dir, `${fileName}_${i}.js`),
        this.code,
      )
      console.log(`${fileName}_${i}.js 写入成功`)
    }
  }

  /**
   * 输出成好看形式 用于对比
   */
  async prettierCode() {
    const newCode = generator(this.ast, {
      minified: false,
      jsescOption: { minimal: true },
      compact: false,
      comments: true,
    }).code
    await fs.writeFile(path.join(this.dir, 'pretty.js'), newCode)
  }

  get decryptFnList() {
    return globalState.decryptFnList
  }

  /**
   * 分离多个 var 赋值
   * @example
   * var a = 1, b = 2;
   * ⬇️
   * var a = 1;
   * var b = 2;
   */
  splitMultipleDeclarations() {
    traverse(this.ast, {
      VariableDeclaration(path) {
        const declarations = path.node.declarations

        if (declarations.length > 1) {
          const newDeclarations = declarations.map((declaration) => {
            return t.variableDeclaration(path.node.kind, [declaration])
          })

          path.replaceWithMultiple(newDeclarations)
        }
      },
    })
    this.reParse()
  }

  /**
   * 嵌套函数花指令替换 需要优先执行 通常内嵌解密函数
   * @param {number} 嵌套深度 针对多次嵌套,默认为 2
   * @example
   * var _0x49afe4 = function (_0x254ae1, _0x559602, _0x3dfa50, _0x13ee81) {
   *   eturn _0x4698(_0x13ee81 - -674, _0x3dfa50);
   * };
   * _0x49afe4(-57, 1080, 828, 469)
   * ⬇️
   * _0x4698(469 - -674, 828)
   */
  nestedFnReplace(depth = 2) {
    /**
     * @param {NodePath<t.FunctionDeclaration | t.FunctionExpression>} path
     */
    const processFunction = (path) => {
      const fnName = path.node.id?.name || path.parentPath.node.id?.name

      if (globalState.decryptFnList.includes(fnName)) return

      /** @type {t.ReturnStatement} */
      const firstStatement = path.node.body?.body?.[0]

      // 在原代码中，函数体就一行 return 语句 并且 参数还是函数表达式
      if (firstStatement && firstStatement.type === 'ReturnStatement' && firstStatement.argument?.type === 'CallExpression') {
        const wrapFn = path
        // 真实调用函数(解密函数)
        const realFn = path.get('body').get('body')[0].get('argument')

        if (!realFn?.node) return

        const binding = path.scope.getBinding(fnName)
        if (!binding) return

        // 遍历 _0x49afe4(-57, 1080, 828, 469)
        binding.referencePaths.forEach((r) => {
          // 通过引用找到调用混淆函数的,需要拿到实际传入的参数
          if (r.parentKey === 'callee' && r.parentPath.type === 'CallExpression') {
            // 调用传入参数 -57, 1080, 828, 469
            const callFn_args = r.parentPath.node.arguments

            // 实际用到的参数 _0x13ee81 - -674, _0x3dfa50
            const realFn_args = realFn.node.arguments

            // 要替换的模版
            let templateCode = generator(realFn.node).code

            // 记录后续模版中要替换的标识符
            const replaceIdentifiers = {}

            // 遍历 (_0x254ae1, _0x559602, _0x3dfa50, _0x13ee81)
            wrapFn.node.params.forEach((param, i) => {
              // 如果模版中不存在标识符则没有用到
              if (templateCode.includes(param.name)) {
                templateCode = templateCode.replace(new RegExp(`${param.name}`, 'g'), `%%${param.name}%%`)

                // 拿到传入参数 如 第四个参数 _0x13ee81 对应 469
                const arg = callFn_args[i]
                replaceIdentifiers[param.name] = arg
              }
            })

            /** @type {t.CallExpression} */
            let newCallExpression = null
            try {
              const buildRequire = template(templateCode)

              const ast = buildRequire(replaceIdentifiers)
              newCallExpression = ast.expression
            }
            catch (error) {
              if (this?.throwWithEval) throw new Error(`模版构建失败 ${error.message}`)
            }

            // console.log(templateCode, generator(newCallExpression).code)

            const callFnName = realFn.node?.callee.name
            if (callFnName && newCallExpression)
              r.parentPath.replaceWith(newCallExpression)
          }
        })

        path.skip()
      }
    }

    /** @type {Visitor} */
    const visitor = {
      FunctionDeclaration(path) {
        return processFunction(path)
      },
      FunctionExpression(path) {
        if (path.parentKey === 'init' && path.parentPath.type === 'VariableDeclarator')
          processFunction(path)
      },
    }

    for (let i = 0; i < depth; i++) {
      traverse(this.ast, visitor)
      this.reParse()
    }
  }

  /**
   * 执行解密替换 传递解密代码将会注入执行
   * @param {*} decryptFnCode
   * @example
   * _0x4698(_0x13ee81, _0x3dfa50)
   * ⬇️
   * 原始字符串
   */
  decryptReplace(decryptFnCode = null) {
    if (globalState.decryptFnList.length === 0) return

    this.log(`解密函数为: ${globalState.decryptFnList.join(',')}`)
    // this.log(`解密函数代码为: ${decryptFnCode}`)
    if (decryptFnCode) {
      // 执行解密函数的代码，这样就可以在全局作用域中运行解密函数来还原数据
      try {
        const result = global.eval(decryptFnCode)
        this.log('解密函数执行结果:', result)
      }
      catch (e) {
        this.log(`解密函数代码为: ${decryptFnCode}`)
        throw new Error('解密函数无法 eval 运行, 请在控制台中查看解密函数是否定位正确')
      }
    }

    const map = new Map()

    traverse(this.ast, {
      CallExpression(path) {
        const callee = path.node.callee

        if (!globalState.decryptFnList.includes(callee.name)) return

        if (!(callee.type === 'Identifier')) return

        try {
          // 如果调用解密函数中有变量参数则不替换
          const hasIdentifier = path.node.arguments.some(a => t.isIdentifier(a))
          if (hasIdentifier) return

          const callCode = path.toString()

          const decStr = eval(callCode)
          map.set(callCode, decStr)

          path.replaceWith(t.stringLiteral(decStr))
        }
        catch (error) {
          // 解密失败 则添加注释
          path.addComment('leading', `解密失败: ${error.message}`, true)

          // 解密失败后是否停止解密
          if (this?.throwWithEval)
            throw new Error(`解密失败 ${error.message}`)
        }
      },
    })

    this.reParse()
    if (map.size > 0)
      this.log('解密结果:', map)
  }

  /**
   * 根据函数调用次数寻找到解密函数(执行代码)
   * @param {number} count 解密函数调用次数
   * @param {boolean} [isRemove] 是否移除解密函数(后续用不到)
   * @returns {string} decryptFnCode
   */
  findDecryptFnByCallCount(count = 100, isRemove = false) {
    if (globalState.decryptFnList.length > 0) return

    let index = 0 // 定义解密函数所在语句下标

    /**
     * @param {NodePath<t.FunctionDeclaration | t.FunctionExpression>} path
     */
    const processFunction = (path) => {
      const fnName = path.node.id?.name || path.parentPath.node.id?.name

      const binding = path.scope.getBinding(fnName)

      if (!binding) return

      if (binding.referencePaths.length >= count) {
        globalState.decryptFnList.push(fnName)

        // 根据最后一个解密函数来定义解密函数所在语句下标
        const binding = path.scope.getBinding(fnName)
        if (!binding) return

        /**
         * @type {NodePath<t.FunctionDeclaration | t.VariableDeclaration>} path
         */
        const parent = binding.path.find(p => p.isFunctionDeclaration() || p.isVariableDeclaration())
        if (!parent) return

        const body = parent.parentPath.scope.block.body

        for (let i = 0; i < body.length; i++) {
          const node = body[i]
          if (node.start === parent.node.start)
            index = i + 1
        }
        // 遍历完当前节点,就不再往子节点遍历
        path.skip()
      }
    }

    traverse(this.ast, {
      FunctionDeclaration(path) {
        if (path.parentPath.isProgram())
          processFunction(path)
      },
      FunctionExpression(path) {
        if (path.parentKey === 'init' && path.parentPath.type === 'VariableDeclarator') {
          const variableDeclarationPath = path.findParent(p => p.isVariableDeclaration())
          if (variableDeclarationPath && variableDeclarationPath.parentPath.isProgram())
            processFunction(path)
        }
      },
    })

    const descryptAst = parser.parse('')
    // 插入解密函数前的几条语句
    descryptAst.program.body = this.ast.program.body.slice(0, index)
    const decryptFnCode = generator(descryptAst, { compact: true }).code

    if (isRemove)
      this.ast.program.body = this.ast.program.body.slice(index)

    return decryptFnCode
  }

  /**
   * 根据大数组定位代码以及寻找到解密函数(执行代码)
   * @param {number} count 数组成员数
   * @param {boolean} [isRemove] 是否移除解密函数(后续用不到)
   * @returns {string} decryptFnCode
   */
  findDecryptFnByBigArr(count = 100, isRemove = false) {
    if (globalState.decryptFnList.length > 0) return

    const descryptAst = parser.parse('')

    traverse(this.ast, {
      ArrayExpression(path) {
        const { node } = path

        if (node.elements.length >= count) {
          const parentPath = path.findParent(p => p.isVariableDeclaration() || p.isExpressionStatement())

          if (!parentPath)
            return

          let bigArrName = ''
          if (t.isVariableDeclaration(parentPath.node))
            bigArrName = parentPath.node.declarations[0].id.name
          else
            bigArrName = parentPath.node.expression.left.name

          const binding = path.scope.getBinding(bigArrName)

          if (binding.referencePaths.length < 10) {
            const variableDeclaration = path.findParent(p => p.isVariableDeclaration())

            // 如果大数组就在 program 下
            if (variableDeclaration.parent.type === 'Program') {
              descryptAst.program.body.push(variableDeclaration.node)

              // 通过引用 找到 数组乱序代码 与 解密函数代码
              binding.referencePaths.forEach((r) => {
                if (r.parentKey === 'object') {
                  // 找到大数组所调用位置,继续向上找,大概率就是解密函数
                  const parent = r.findParent(p => p.isFunctionDeclaration() || p.isFunctionExpression())
                  if (parent) {
                    const decryptFnName = parent.node.id?.name
                    if (decryptFnName)
                      globalState.decryptFnList.push(decryptFnName)

                    descryptAst.program.body.push(parent.node)

                    isRemove && parent.remove()
                  }
                  return
                }

                if (r.parentKey === 'arguments') {
                  const parent = r.findParent(p => p.isExpressionStatement())
                  if (parent) {
                    descryptAst.program.body.push(parent.node)

                    isRemove && parent.remove()
                  }
                }
              })

              isRemove && variableDeclaration.remove()
            }
            else {
            // 不断向上找,找到 program 下 的代码块
              const parent = path.findParent(p => p.isFunctionDeclaration() || p.isFunctionExpression())

              if (parent.type === 'FunctionDeclaration') {
                const fnName = parent.node.id.name

                // 重新找大数组变量名
                const binding = path.scope.getBinding(fnName)

                // 通过引用 找到 数组乱序代码 与 解密函数代码
                binding.referencePaths.forEach((r) => {
                  if (r.parentKey === 'callee') {
                  // 找到大数组所调用位置,继续向上找,大概率就是解密函数
                    const parent = r.findParent(p => p.isFunctionDeclaration() || p.isFunctionExpression())
                    if (parent) {
                      const decryptFnName = parent.node.id?.name
                      if (decryptFnName && decryptFnName !== fnName)
                        globalState.decryptFnList.push(decryptFnName)

                      descryptAst.program.body.push(parent.node)

                      isRemove && parent.remove()
                    }
                    return
                  }

                  if (r.parentKey === 'arguments') {
                    const parent = r.findParent(p => p.isExpressionStatement())
                    if (parent) {
                      descryptAst.program.body.push(parent.node)

                      isRemove && parent.remove()
                    }
                  }
                })
              }
            }
          }

          path.skip()
        }
      },
    })

    const decryptFnCode = generator(descryptAst, { compact: true }).code

    return decryptFnCode
  }

  /**
   * 指明解密函数 当指明后,所有引用该变量赋值的代码都将替换成解密函数
   * @param {string | string[]} decryptFnList
   * @example
   * function _0x3028(_0x2308a4){ ... } // _0x3028 为解密函数
   * var a = _0x3028; // 将被移除
   * a('0x1')
   * ⬇️
   * _0x3028('0x1')
   */
  designDecryptFn(decryptFnList) {
    if (decryptFnList) {
      if (!Array.isArray(decryptFnList))
        globalState.decryptFnList = [decryptFnList]
      else
        globalState.decryptFnList = decryptFnList
    }

    // 将所有引用解密函数的变量都重命名变为解密函数, 同时移除自身
    traverse(this.ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node

        if (init && init.type === 'Identifier') {
          const decryptFn = globalState.decryptFnList.find(n => n === init.name)

          if (decryptFn) {
            path.scope.rename(id.name, decryptFn)
            path.remove()
          }
        }
      },
    })

    this.reParse()
  }

  /**
   * 注入代码 eval 执行
   */
  evalCode(code) {
    const result = global.eval(code)

    this.log('注入代码执行结果', result)
  }

  /**
   * 保存代码中所有对象用于后续替换
   * @example
   * var r = {
   *   "PzXHf": "0|2|4|3|1",
   *   "LeQrV": function (n, t) {
   *     return n(t);
   *   }
   * }
   * r["wPpOS"]: "webgl"
   * ⬇️
   * var r = {
   *   "PzXHf": "0|2|4|3|1",
   *   "LeQrV": function (n, t) {
   *     return n(t);
   *   }
   *   "wPpOS": "webgl"
   * }
   *
   * //  全局变量状态会保存 r 对象
   * globalState.objectVariables = {
   *   r = { ... }
   * }
   */
  saveAllObject() {
    globalState.objectVariables = {}

    const scopes = []

    function addReplaceScope() {

    }

    traverse(this.ast, {
      VariableDeclaration: {
        exit(path, state) {
          path.node.declarations.forEach((declaration) => {
            if (declaration.id.type === 'Identifier') {
              const objectName = declaration.id.name
              if (declaration.init?.type === 'ObjectExpression') {
                globalState.objectVariables[`${declaration.start}_${objectName}`] = declaration.init

                // 在同作用域下将变量重命名 var u = e; ---> var e = e; 同时一并移除
                const binding = path.scope.getBinding(objectName)
                if (!(binding && binding.path.node.type === 'VariableDeclarator' && binding.path.node.init?.type === 'ObjectExpression')) return
                if (!binding.constant && binding.constantViolations.length === 0) return

                scopes.push({
                  parentPath: path.getStatementParent()?.parentPath,
                  objectName,
                })
              }
            }
          })
        },
      },

    })

    /**
     * 合并对象  如果有相同 key 则覆盖
     * var a = {}
     * a["b"] = 123
     * ⬇️
     * var a = {
     *  "b": 123
     * }
     */
    traverse(this.ast, {
      AssignmentExpression: {
        exit(path) {
          const { left, right } = path.node
          if (left.type !== 'MemberExpression') return

          if (!t.isLiteral(left.property)) return

          if (!(
            t.isFunctionExpression(right)
            || t.isLiteral(right)
            || t.isIdentifier(right)
            || t.isBinaryExpression(right)
            || t.isObjectExpression(right)
          )) return

          const objectName = left.object.name

          // 在同作用域下将变量重命名 var u = e; ---> var e = e; 同时一并移除
          const binding = path.scope.getBinding(objectName)

          // 判断 原 object 是否为 var e = {}
          if (!(binding && binding.path.node.type === 'VariableDeclarator' && binding.path.node.init?.type === 'ObjectExpression')) return
          if (!binding.constant && binding.constantViolations.length === 0) return

          // 同时判断对象初始化的成员长度(避免不必要的替换),一般为空 {}
          // !!! 但是 后续填充的时候会更改原对象长度,这里可能需要做个缓存
          // if (binding.path.node.init.properties.length !== 0)
          //   return

          scopes.push({
            parentPath: path.getStatementParent()?.parentPath,
            objectName,
          })

          const start = binding.identifier.start

          let isReplace = false
          try {
            const prop = t.objectProperty(left.property, right)
            if (globalState.objectVariables[`${start}_${objectName}`]) {
              const keyIndex = globalState.objectVariables[`${start}_${objectName}`].properties.findIndex((p) => {
                return left.property.value === p.key.name || left.property.value === p.key.value
              })
              if (keyIndex !== -1)
                globalState.objectVariables[`${start}_${objectName}`].properties[keyIndex] = prop

              else
                globalState.objectVariables[`${start}_${objectName}`].properties.push(prop)

              isReplace = true
            }
          }
          catch (error) {
            throw new Errror('生成表达式失败')
          }

          if (isReplace) {
            if (path.parentPath.type === 'SequenceExpression' || path.parentPath.type === 'ExpressionStatement')
              path.remove() // 移除自身赋值语句
          }

          path.skip()
        },
      },
    })

    scopes.forEach(({ parentPath, objectName }) => {
      parentPath?.traverse({
        VariableDeclarator(p) {
          const { id, init } = p.node

          if (init && init.type === 'Identifier' && id.type === 'Identifier') {
            if (init.name === objectName) {
              p.scope.rename(id.name, objectName)
              // !!! 移除后 再次解析会导致 start 定位变更, 致使后续对象替换失效, 因此注释下列 this.reParse 代码
              p.parentPath.remove()
            }
          }
        },
      })
    })

    // this.reParse()
  }

  /** 获取已保存的所有变量 (供测试用) */
  getAllObject() {
    return globalState.objectVariables
  }

  /**
   * 花指令 对象属性替换 需要先执行 saveAllObjectect 用于保存所有变量
   * @example
   * var r = {
   *   "PzXHf": "0|2|4|3|1",
   *   "LeQrV": function (n, t) {
   *     return n(t);
   *   }
   * }
   *
   * var u = r["PzXHf"]["split"]("|");
   * r["LeQrV"](_0x3028, "foo");
   * ⬇️
   * var u = "0|2|4|3|1"["split"]("|");
   * _0x3028("foo")
   */
  objectMemberReplace() {
    // 记录被替换的对象, 如何对象没被修改过则删除
    const usedMap = new Map()
    let usedObjects = {}

    /**
     * 字面量花指令还原
     * r["PzXHf"] ---> "0|2|4|3|1"
     */
    traverse(this.ast, {
      MemberExpression(path) {
        // 父级表达式不能是赋值语句
        const asignment = path.parentPath
        if (!asignment || asignment?.type === 'AssignmentExpression')
          return

        const { object, property } = path.node
        if (object.type === 'Identifier' && (property.type === 'StringLiteral' || property.type === 'Identifier')) {
          const objectName = object.name

          // 找到 objectName 的定义位置
          const binding = path.scope.getBinding(objectName)
          if (!binding)
            return

          const start = binding.identifier.start

          //    xxx            obj['xxx']        obj.xxx
          const propertyName = property.value || property.name

          if (globalState.objectVariables[`${start}_${objectName}`]) {
            const objectInit = globalState.objectVariables[`${start}_${objectName}`]

            const properties = objectInit.properties
            for (const prop of properties) {
              const keyName = prop.key.value || prop.key.name
              if (
                (prop.key.type === 'StringLiteral'
                || prop.key.type === 'Identifier')
                && keyName === propertyName
                && t.isLiteral(prop.value)
              ) {
                // 还需要判断 objectName[propertyName] 是否被修改过
                const binding = path.scope.getBinding(objectName)
                if (binding && binding.constant && binding.constantViolations.length === 0) {
                  // 针对一些特殊代码不进行处理 如 _0x52627b["QqaUY"]++
                  if (path.parent.type === 'UpdateExpression')
                    return

                  usedMap.set(`${objectName}.${propertyName}`, generator(prop.value).code)

                  usedObjects[objectName] = usedObjects[objectName] || new Set()
                  usedObjects[objectName].add(propertyName)

                  path.replaceWith(prop.value)
                }
              }
            }
          }
        }
      },
    })

    /**
     * 函数花指令还原
     * r["LeQrV"](_0x3028, "foo");  --->  _0x3028("foo");
     */
    traverse(this.ast, {
      CallExpression(path) {
        const { callee } = path.node
        if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier') {
          const objectName = callee.object.name
          const propertyName = callee.property.value || callee.property.name

          // 找到 objectName 的定义位置
          const binding = path.scope.getBinding(objectName)
          if (!binding)
            return

          const start = binding.identifier.start

          if (globalState.objectVariables[`${start}_${objectName}`]) {
            const objectInit = globalState.objectVariables[`${start}_${objectName}`]

            const properties = objectInit.properties

            // 实际传递参数
            const argumentList = path.node.arguments

            for (const prop of properties) {
              const keyName = prop.key.value || prop.key.name
              if (
                (prop.key.type === 'StringLiteral'
                || prop.key.type === 'Identifier')
                && prop.value.type === 'FunctionExpression'
                && keyName === propertyName
              ) {
                // 拿到定义函数
                const orgFn = prop.value

                // 在原代码中，函数体就一行 return 语句，取出其中的 argument 属性与调用节点替换
                const firstStatement = orgFn.body.body?.[0]
                if (firstStatement?.type !== 'ReturnStatement') return

                // 返回参数
                const returnArgument = firstStatement.argument

                let isReplace = false
                if (t.isBinaryExpression(returnArgument)) {
                  // _0x5a2810 + _0x2b32f4
                  const binaryExpression = t.binaryExpression(
                    returnArgument.operator,
                    argumentList[0],
                    argumentList[1],
                  )
                  path.replaceWith(binaryExpression)
                  isReplace = true
                }
                else if (t.isLogicalExpression(returnArgument)) {
                  // _0x5a2810 || _0x2b32f4
                  const logicalExpression = t.logicalExpression(
                    returnArgument.operator,
                    argumentList[0],
                    argumentList[1],
                  )
                  path.replaceWith(logicalExpression)
                  isReplace = true
                }
                else if (t.isUnaryExpression(returnArgument)) {
                  // !_0x5a2810
                  const unaryExpression = t.unaryExpression(
                    returnArgument.operator,
                    argumentList[0],
                  )
                  path.replaceWith(unaryExpression)
                  isReplace = true
                }
                else if (t.isCallExpression(returnArgument)) {
                  // function (_0x1d0a4d, _0x1df411) {
                  //   return _0x1d0a4d();
                  // }

                  // 取出是哪个参数作为函数名来调用 因为可能会传递多个参数，取其中一个或几个
                  // 确保调用函数名必须是标识符才替换
                  if (returnArgument.callee.type !== 'Identifier')
                    return

                  const callFnName = returnArgument.callee.name // 形参的函数名

                  // 找到从传递的多个参数中 定位索引
                  const callIndex = orgFn.params.findIndex(
                    a => a.name === callFnName,
                  )

                  // 再从实际参数(实参)中找到真正函数名
                  const realFnName = argumentList.splice(callIndex, 1)[0]
                  const callExpression = t.callExpression(
                    realFnName,
                    argumentList,
                  )
                  path.replaceWith(callExpression)
                  isReplace = true
                }

                if (isReplace) {
                  usedMap.set(`${objectName}.${propertyName}`, generator(orgFn).code)

                  usedObjects[objectName] = usedObjects[objectName] || new Set()
                  usedObjects[objectName].add(propertyName)
                }
              }
            }
          }
        }
      },
    })

    this.reParse()

    const removeSet = new Set()

    /**
     * 移除已使用过的 property(key)
     * var _0x52627b = {
     *  'QqaUY': "attribute",
     *  SDgrw: "123"
     * }
     * _0x52627b["QqaUY"]
     * 🔽
     * var _0x52627b = {
     *  SDgrw: "123"
     * }
     * "attribute"
     */
    if (!isEmpty(usedObjects)) {
      traverse(this.ast, {
        ObjectProperty(path) {
          let objectName = ''
          if (path.parentPath.parentPath.type === 'AssignmentExpression')
            objectName = path.parentPath.parentPath.node.left.name

          else if (path.parentPath.parentPath.type === 'VariableDeclarator')
            objectName = path.parentPath.parentPath.node.id.name

          if (!objectName) return

          const propertyName = path.node.key.value || path.node.key.name

          if (usedObjects[objectName]?.has(propertyName)) {
            path.remove()
            removeSet.add(`${objectName}.${propertyName}`)
          }
        },
      })
    }

    usedObjects = {}

    if (usedMap.size > 0)
      this.log(`已被替换对象: `, usedMap)

    if (removeSet.size > 0)
      this.log(`已移除key列表:`, removeSet)
  }

  /**
   * 将 for 初始化赋值前置
   * @example
   * for (a = 1, w = "2|1|2|3"["split"]("|"), void 0;;) {
   *   var a;
   *   var w;
   *   break;
   * }
   * 🔽
   * var a = 1;
   * var w = "2|1|2|3"["split"]("|")
   * for (void 0;;) {
   *    break;
   * }
   */
  transformForLoop() {
    traverse(this.ast, {
      ForStatement(path) {
        if (path.node.init && path.node.init.type === 'SequenceExpression') {
          const expressions = path.node.init.expressions

          const toRemoveVariableDeclarators = []
          const declarations = []
          expressions.forEach((expression, index) => {
            if (expression.type === 'AssignmentExpression') {
              toRemoveVariableDeclarators.push(expression.left.name)

              if (expression.left.type === 'Identifier') {
                declarations.push(
                  t.variableDeclaration('var', [
                    t.variableDeclarator(
                      t.identifier(expression.left.name),
                      expression.right,
                    ),
                  ]),
                )
              }
            }
          })

          path.node.init.expressions = path.node.init.expressions.filter(
            (e) => {
              if (e.type === 'AssignmentExpression')
                return !toRemoveVariableDeclarators.includes(e.left.name)
              else
                return true
            },
          )

          // 必须要删除 后续的 var 会影响判断
          path.traverse({
            VariableDeclarator(p) {
              const name = p.node.id?.name
              if (p.node.init === null) {
                if (toRemoveVariableDeclarators.includes(name))
                  p.remove()
              }
            },
          })

          const statement = path.getStatementParent()

          path.insertBefore(declarations)
        }
      },
    })
    this.reParse()
  }

  /**
   * 控制流扁平化
   * @example
   * function a() {
   *   var _0x263cfa = "1|3|2|0"["split"]("|"),
   *   _0x105b9b = 0;
   *
   *   while (true) {
   *      switch (_0x263cfa[_0x105b9b++]) {
   *        case "0":
   *          return _0x4b70fb;
   *
   *        case "1":
   *          if (_0x3d66ff !== "link" && _0x3d66ff !== "script") {
   *            return;
   *          }
   *          continue;
   *
   *        case "2":
   *          _0x4b70fb["charset"] = "utf-8";
   *          continue;
   *
   *        case "3":
   *          var _0x4b70fb = document["createElement"](_0x3d66ff);
   *          continue;
   *    }
   *    break;
   *   }
   * }
   * ⬇️
   * function a(){
   *   if (_0x3d66ff !== "link" && _0x3d66ff !== "script") {
   *     return;
   *   }
   *   var _0x4b70fb = document["createElement"](_0x3d66ff);
   *   _0x4b70fb["charset"] = "utf-8";
   *   return _0x4b70fb;
   * }
   */
  controlFlowFlat() {
    this.transformForLoop()

    traverse(this.ast, {
      SwitchStatement(path) {
        // 判断父节点是否为循环节点
        const forOrWhileStatementPath = path.findParent(p => p.isForStatement() || p.isWhileStatement())

        if (!forOrWhileStatementPath) return

        // 拿到函数的块语句
        const fnBlockStatementPath = forOrWhileStatementPath.findParent(p => p.isBlockStatement())

        let shufferArr = []

        // 从整个函数的 BlockStatement 中遍历寻找 "1|3|2|0"["split"]
        fnBlockStatementPath.traverse({
          MemberExpression(path) {
            const { object, property } = path.node
            const propertyName = property.value || property.name
            if (
              (t.isStringLiteral(property)
              || t.isIdentifier(property))
              && propertyName === 'split'
            ) {
              if (t.isStringLiteral(object)) {
                const shufferString = object.value // "1|3|2|0"
                shufferArr = shufferString.split('|')

                // 顺带移除 var _0x263cfa = "1|3|2|0"["split"]("|"),
                const VariableDeclarator = path.findParent(p => p.isVariableDeclarator())

                if (VariableDeclarator)
                  VariableDeclarator.remove()

                path.stop()
              }
            }
          },
        })

        if (shufferArr.length === 0)
          return

        const myArr = path.node.cases
          .filter(p => p.test?.type === 'StringLiteral')
          .map(p => p.consequent[0])

        const sequences = shufferArr
          .map(s => myArr[s])
          .filter(s => s?.type !== 'ContinueStatement') // 如果 case 语句 只有 continue 则跳过

        fnBlockStatementPath.node.body.push(...sequences)

        // 将整个循环体都移除
        if (['WhileStatement', 'ForStatement'].includes(path.parentPath.parentPath.type))
          path.parentPath.parentPath.remove()

        path.skip()
      },
    })
  }

  /**
   * 还原逗号表达式
   * @example
   * _0x6cbcff(), console.log('foo')
   * ⬇️
   * _0x6cbcff();
   * console.log('foo');
   */
  restoreSequence() {
    traverse(this.ast, {
      SequenceExpression: {
        exit(path) {
          // 排除
          if (['test', 'left', 'right'].includes(path.parentKey)) return

          const exporessions = path.node.expressions
          const finalExpression = exporessions[exporessions.length - 1]
          const statement = path.getStatementParent()

          exporessions.slice(0, -1).forEach((e) => {
            statement.insertBefore(t.ExpressionStatement(e))
          })
          path.replaceInline(finalExpression)
        },
      },
    })

    this.reParse()
  }

  /**
   * 移除自调用函数
   * @example
   * !function() {
   *  a()
   * }();
   * ⬇️
   * {
   *   a()
   * }
   */
  removeSelfCallFn() {
    traverse(this.ast, {
      ExpressionStatement(path) {
        const expression = path.node.expression
        if (
          expression.type === 'UnaryExpression'
          && expression.argument.type === 'CallExpression'
          && expression.argument.callee.type === 'FunctionExpression'
          && expression.argument.arguments.length === 0
        ) {
          path.replaceWith(expression.argument.callee.body)
          path.skip()
        }
      },
    })

    this.reParse()
  }

  /**
   * 自调用函数执行并替换
   * @example
   * ;(function (_0x4f0d08) {
   *   return function (_0x4f0d08) {
   *     return Function("Function(arguments[0]+\"" + _0x4f0d08 + "\")()");
   *   }(_0x4f0d08);
   * })("bugger")("de");
   * 🔽
   * Function("Function(arguments[0]+\"" + "bugger" + "\")()")("de")
   */
  selfCallFnReplace() {
    traverse(this.ast, {
      CallExpression(path) {
        if (t.isFunctionExpression(path.node.callee)) {
          // 找到 return 语句
          const firstStatement = path.node.callee.body.body?.[0]
          if (!(firstStatement?.type === 'ReturnStatement'))
            return

          // ['bugger']
          const outerArguments = path.node.arguments

          // function (_0x4f0d08) { return xxx }(_0x4f0d08)
          const innerFunction = firstStatement.argument

          // [_0x4f0d08]
          const innerArguments = innerFunction.arguments
          if (!innerArguments)
            return

          // 还需要根据传递的参数 将 _0x4f0d08 改成 bugger
          innerArguments?.forEach((argument, index) => {
            path
              .get('callee')
              .get('body')
              .get('body')[0]
              .get('argument')
              .get('callee')
              .traverse({
                Identifier(p) {
                  if (
                    p.parentKey !== 'params'
                      && p.node.name === argument.name
                  )
                    p.replaceWith(outerArguments[index])
                },
              })
          })

          if (t.isCallExpression(innerFunction) && innerFunction.arguments.length === 1) {
            const firstStatement = innerFunction.callee.body?.body?.[0]
            if (!(firstStatement?.type === 'ReturnStatement'))
              return

            // Function("Function(arguments[0]+\"" + _0x4f0d08 + "\")()");
            const finalExpression = firstStatement.argument

            if (finalExpression.type === 'CallExpression')
              path.replaceWith(finalExpression)

            path.skip()
          }
        }
      },
    })
  }

  /**
   * 将字符串和数值 常量 直接替换对应的变量引用地方
   * @example
   * let a = "debugger";
   * console.log(a)
   * ⬇️
   * console.log("debugger")
   */
  replaceConstant() {
    /**
     * @param {NodePath} path
     * @param {t.Node} value
     */
    function replaceConstantVariable(path, value) {
      const name = path.node.id ? path.node.id.name : path.node.left.name
      const binding = path.scope.getBinding(name)

      if (binding && binding.constant && binding.constantViolations.length === 0) {
        binding.referencePaths.forEach((r) => {
          r.replaceWith(value)
        })

        path.remove()
      }
    }

    traverse(this.ast, {
      AssignmentExpression(path) {
        const value = path.node.right
        if (t.isStringLiteral(value) || t.isNumericLiteral(value))
          replaceConstantVariable(path, value)
      },
      VariableDeclarator(path) {
        const value = path.node.init
        if (t.isStringLiteral(value) || t.isNumericLiteral(value))
          replaceConstantVariable(path, value)
      },
    })

    this.reParse()
  }

  /**
   * 计算二项式字面量 计算布尔值
   * @example
   * 1 + 2   "debu" + "gger"
   * ⬇️
   * 3       "debugger"
   */
  calcBinary() {
    // 递归处理二项式 例 '1' + '2' + '3' ---> '123'
    function transformConcatenated(path) {
      const { left, right, operator } = path.node

      const hasIdentifier = [left, right].some(a => t.isIdentifier(a))
      if (hasIdentifier) return

      if (t.isLiteral(left) && t.isLiteral(right)) {
        const { confident, value } = path.evaluate()
        confident && path.replaceWith(t.valueToNode(value))

        if (path.parentPath.type === 'BinaryExpression')
          transformConcatenated(path.parentPath)

        path.skip()
      }
    }

    traverse(this.ast, {
      BinaryExpression(path) {
        transformConcatenated(path)
      },
    })

    this.reParse()

    traverse(this.ast, {
      UnaryExpression(path) {
        if (path.node.operator !== '!')
          return // 避免判断成 void

        // 判断第二个符号是不是!
        if (t.isUnaryExpression(path.node.argument)) {
          if (t.isArrayExpression(path.node.argument.argument)) {
            // !![]
            if (path.node.argument.argument.elements.length === 0) {
              path.replaceWith(t.booleanLiteral(true))
              path.skip()
            }
          }
        }
        else if (t.isArrayExpression(path.node.argument)) {
          // ![]
          if (path.node.argument.elements.length === 0) {
            path.replaceWith(t.booleanLiteral(false))
            path.skip()
          }
        }
        else if (t.isNumericLiteral(path.node.argument)) {
          // !0 or !1
          if (path.node.argument.value === 0)
            path.replaceWith(t.booleanLiteral(true))
          else if (path.node.argument.value === 1)
            path.replaceWith(t.booleanLiteral(false))
        }
      },
    })

    this.reParse()
  }

  /**
   * 清理无用变量与函数
   * @example
   * let a = 1;
   * ⬇️
   *
   */
  removeUnusedVariables(variableNames = null, excludeProgram = true) {
    function processDeclaration(path, name) {
      // 如果有指定变量排除的话
      if (variableNames && !variableNames.includes(name)) {
        path.skip()
        return
      }

      const binding = path.scope.getBinding(name)

      if (!binding || binding.constantViolations.length > 0) return

      if (binding.referencePaths.length > 0) return

      if (excludeProgram && binding.scope?.block?.type === 'Program') return

      path.remove()
    }

    // 遍历所有赋值变量
    traverse(this.ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node

        if (!(t.isLiteral(init) || t.isObjectExpression(init) || t.isFunctionExpression(init)))
          return

        const name = id.name
        processDeclaration(path, name)
      },
      FunctionDeclaration(path) {
        const name = path.node.id.name
        processDeclaration(path, name)
      },
    })
  }

  /**
   * 移除始终不会执行的代码块
   * @example
   * if(false){
   *  // aaa
   * }else{
   *  // bbb
   * }
   * ⬇️
   * // bbb
   */
  removeUnusedBlock() {
    /**
     * @param {NodePath} path
     * @param {t.Node} path
     */
    function replace(path, node) {
      if (t.isBlockStatement(node))
        path.replaceWithMultiple(node.body)
      else
        path.replaceWith(node)
    }

    /**
     * @param {NodePath<t.IfStatement | t.ConditionalExpression>} path
     */
    const process = function (path) {
      const { consequent, alternate } = path.node
      const { scope } = path

      /**
       * 由于块范围与父范围合并，我们需要重命名这些，避免重复声明的变量。
       * @param {Scope} localScope
       */
      function rename(localScope) {
        if (localScope === scope) return

        for (const name in localScope.bindings) {
          if (scope.hasBinding(name)) {
            const newName = scope.generateUid(name)
            localScope.bindings[name].referencePaths.forEach((ref) => {
              // 避免与其他同名绑定发生冲突
              if (ref.scope.hasBinding(newName))
                ref.scope.rename(newName)
            })

            localScope.bindings[name].identifier.name = newName
          }
        }
      }

      if (path.get('test').evaluateTruthy()) {
        rename(path.get('consequent').scope)
        replace(path, consequent)
      }
      else if (path.node.alternate) {
        rename(path.get('alternate').scope)
        replace(path, alternate)
      }
      else { path.remove() }
    }

    traverse(this.ast, {
      IfStatement: { exit(path) { process(path) } },
      ConditionalExpression: { exit(path) { process(path) } },
    })
    this.reParse()
  }

  /**
   * 清理十六进制编码
   * @example
   * "\x49\x63\x4b\x72\x77\x70\x2f\x44\x6c\x67\x3d\x3d"
   * ⬇️
   * "IcKrwp/Dlg=="
   */
  deleteExtra() {
    traverse(this.ast, {
      StringLiteral(path) {
        delete path.node.extra
      },
      NumericLiteral(path) {
        delete path.node.extra
      },
    })
  }

  /**
   * 给关键函数、标识符 设置注释
   * @example
   * debugger;
   * ⬇️
   * // TOLOOK
   * debugger;
   */
  markComment(keywords = [], label = ' TOLOOK') {
    const defaultKeywords = ['debugger']
    keywords = [
      ...new Set([...keywords.map(k => k.toLowerCase()), ...defaultKeywords]),
    ]

    traverse(this.ast, {
      DebuggerStatement(path) {
        // 如果已注释,则跳过
        const hasComment = path.node.leadingComments?.find(
          c => (c.value = label),
        )
        if (hasComment)
          return

        path.addComment('leading', label, true)
      },
      CallExpression(path) {
        if (path.node.callee.type === 'MemberExpression') {
          if (
            !['setTimeout', 'setInterval'].includes(
              path.node.callee.property?.value,
            )
          )
            return
          path.addComment('leading', label, true)
          return
        }

        if (!['setTimeout', 'setInterval'].includes(path.node.callee.name))
          return
        path.addComment('leading', label, true)
      },
      StringLiteral(path) {
        if (keywords.includes(path.node.value.toLowerCase())) {
          const statementPath = path.findParent(p => p.isStatement())
          if (statementPath)
            statementPath.addComment('leading', label, true)
          else path.addComment('leading', label, true)
        }
      },
      Identifier(path) {
        const name = path.node.name
        if (keywords.includes(name.toLowerCase())) {
          const statementPath = path.findParent(p => p.isStatement())
          if (statementPath)
            statementPath.addComment('leading', label, true)
          else path.addComment('leading', label, true)
        }
      },
    })
  }

  /**
   * 禁用 debugger
   * @todo
   */
  disableDebugger() {
    // xxx
  }

  /**
   * 优化变量名
   * @example
   * catch (_0x292610) {}
   * ⬇️
   * catch (error) {}
   * @deprecated
   */
  optimizeIdentifierName() {
    const code = this.code
    const newAst = parser.parse(code)
    traverse(newAst, {
      'Program|FunctionExpression|FunctionDeclaration': function (path) {
        path.traverse({
          Identifier(p) {
            path.scope.rename(
              p.node.name,
              path.scope.generateUidIdentifier('_0xaaaaaa').name,
            )
          },
        })
      },
    })
    this.ast = newAst
  }
}
