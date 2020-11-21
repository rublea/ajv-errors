import type {Plugin, CodeKeywordDefinition, KeywordCxt, ErrorObject, Code} from "ajv"
import Ajv, {_, str, stringify, Name} from "ajv"
import {and, or, not, strConcat} from "ajv/dist/compile/codegen"
import {reportError} from "ajv/dist/compile/errors"
import N from "ajv/dist/compile/names"

type ErrorsMap<T extends string | number> = {[P in T]?: ErrorObject[]}

type StringMap = {[P in string]?: string}

type ErrorMessageSchema = {
  properties?: StringMap
  items?: string[]
  required?: string | StringMap
  dependencies?: string | StringMap
  _?: string
} & {[K in string]?: string | StringMap}

interface ChildErrors {
  props?: ErrorsMap<string>
  items?: ErrorsMap<number>
}

const keyword = "errorMessage"

const used: Name = new Name("emUsed")

const KEYWORD_PROPERTY_PARAMS = {
  required: "missingProperty",
  dependencies: "property",
}

export interface ErrorMessageOptions {
  keepErrors?: boolean
  singleError?: boolean
}

function errorMessage(options: ErrorMessageOptions): CodeKeywordDefinition {
  return {
    keyword,
    schemaType: ["string", "object"],
    post: true,
    code(cxt: KeywordCxt) {
      const {gen, data, schema, schemaValue, it} = cxt
      if (it.createErrors === false) return
      const sch: ErrorMessageSchema | string = schema
      const dataPath = strConcat(N.dataPath, it.errorPath)
      gen.if(_`${N.errors} > 0`, () => {
        if (typeof sch == "object") {
          const [kwdPropErrors, kwdErrors] = keywordErrorsConfig(sch)
          if (kwdErrors) processKeywordErrors(kwdErrors)
          if (kwdPropErrors) processKeywordPropErrors(kwdPropErrors)
          processChildErrors(childErrorsConfig(sch))
        }
        const schMessage = typeof sch == "string" ? sch : sch._
        if (schMessage) processAllErrors(schMessage)
        if (!options.keepErrors) removeUsedErrors()
      })

      function childErrorsConfig({properties, items}: ErrorMessageSchema): ChildErrors {
        const errors: ChildErrors = {}
        if (properties) {
          errors.props = {}
          for (const p in properties) errors.props[p] = []
        }
        if (items) {
          errors.items = {}
          for (let i = 0; i < items.length; i++) errors.items[i] = []
        }
        return errors
      }

      function keywordErrorsConfig(
        emSchema: ErrorMessageSchema
      ): [{[K in string]?: ErrorsMap<string>} | undefined, ErrorsMap<string> | undefined] {
        let propErrors: {[K in string]?: ErrorsMap<string>} | undefined
        let errors: ErrorsMap<string> | undefined

        for (const k in emSchema) {
          if (k === "properties" || k === "items") continue
          const kwdSch = emSchema[k]
          if (typeof kwdSch == "object") {
            propErrors ||= {}
            const errMap: ErrorsMap<string> = (propErrors[k] = {})
            for (const p in kwdSch) errMap[p] = []
          } else {
            errors ||= {}
            errors[k] = []
          }
        }
        return [propErrors, errors]
      }

      function processKeywordErrors(kwdErrors: ErrorsMap<string>): void {
        const kwdErrs = gen.const("emErrors", stringify(kwdErrors))
        gen.forOf("err", N.vErrors, (err) =>
          gen.if(matchKeywordError(err, kwdErrs), () => {
            gen.code(_`${kwdErrs}[${err}.keyword].push(${err})`).assign(_`${err}.${used}`, true)
          })
        )
        const {singleError} = options
        if (singleError) {
          const message = gen.let("message", _`""`)
          const paramsErrors = gen.const("paramsErrors", _`[]`)
          loopErrors((key) => {
            gen.if(message, () =>
              gen.code(_`${message} += ${typeof singleError == "string" ? singleError : ";"}`)
            )
            gen.code(_`${message} += ${schemaValue}[${key}]`) // TODO add template support
            gen.assign(paramsErrors, _`${paramsErrors}.concat(${kwdErrs}[${key}])`)
          })
          reportError(cxt, {
            message: () => message,
            params: () => _`{errors: ${paramsErrors}}`,
          })
        } else {
          loopErrors((key) =>
            reportError(cxt, {
              message: () => _`${schemaValue}[${key}]`, // TODO add template support
              params: () => _`{errors: ${kwdErrs}[${key}]}`,
            })
          )
        }

        function loopErrors(body: (key: Name) => void): void {
          gen.forIn("key", kwdErrs, (key) => gen.if(_`${kwdErrs}[${key}].length`, () => body(key)))
        }
      }

      function processKeywordPropErrors(kwdPropErrors: {[K in string]?: ErrorsMap<string>}): void {
        const kwdErrs = gen.const("emErrors", stringify(kwdPropErrors))
        const kwdPropParams = gen.scopeValue("obj", {
          ref: KEYWORD_PROPERTY_PARAMS,
          code: stringify(KEYWORD_PROPERTY_PARAMS),
        })
        const propParam = gen.let("emPropParams")
        const paramsErrors = gen.let("emParamsErrors")

        gen.forOf("err", N.vErrors, (err) =>
          gen.if(matchKeywordError(err, kwdErrs), () => {
            gen.assign(propParam, _`${kwdPropParams}[${err}.keyword]`)
            gen.assign(paramsErrors, _`${kwdErrs}[${err}.keyword][${err}.params[${propParam}]]`)
            gen.if(paramsErrors, () =>
              gen.code(_`${paramsErrors}.push(${err})`).assign(_`${err}.${used}`, true)
            )
          })
        )

        gen.forIn("key", kwdErrs, (key) =>
          gen.forIn("keyProp", _`${kwdErrs}[${key}]`, (keyProp) => {
            gen.assign(paramsErrors, _`${kwdErrs}[${key}][${keyProp}]`)
            gen.if(_`${paramsErrors}.length`, () => {
              reportError(cxt, {
                message: () => _`${schemaValue}[${key}][${keyProp}]`, // TODO add template support
                params: () => _`{errors: ${paramsErrors}}`,
              })
            })
          })
        )
      }

      function processChildErrors(childErrors: ChildErrors): void {
        const {props, items} = childErrors
        if (!props && !items) return
        const isObj = _`typeof ${data} == "object"`
        const isArr = _`Array.isArray(${data})`
        const childErrs = gen.let("emErrors")
        let childKwd: Name
        let childProp: Code
        if (props && items) {
          childKwd = gen.let("emChildKwd")
          gen.if(isObj)
          gen.if(
            isArr,
            () => gen.assign(childErrs, stringify(items)).assign(childKwd, str`items`),
            () => gen.assign(childErrs, stringify(props)).assign(childKwd, str`properties`)
          )
          childProp = _`[${childKwd}]`
        } else if (props) {
          gen.if(and(isObj, not(isArr))).assign(childErrs, stringify(props))
          childProp = _`.properties`
        } else {
          gen.if(isArr).assign(childErrs, stringify(items))
          childProp = _`.items`
        }

        gen.forOf("err", N.vErrors, (err) =>
          ifMatchesChildError(err, childErrs, (child) =>
            gen.code(_`${childErrs}[${child}].push(${err})`).assign(_`${err}.${used}`, true)
          )
        )

        gen.forIn("key", childErrs, (key) =>
          gen.if(_`${childErrs}[${key}].length`, () => {
            reportError(cxt, {
              message: () => _`${schemaValue}${childProp}[${key}]`, // TODO add template support
              params: () => _`{errors: ${childErrs}[${key}]}`,
            })
            gen.assign(
              _`${N.vErrors}[${N.errors}-1].dataPath`,
              _`${dataPath} + "/" + ${key}.replace(/~/g, "~0").replace(/\\//g, "~1")`
            )
          })
        )

        gen.endIf()
      }

      function processAllErrors(schMessage: string): void {
        const errs = gen.const("emErrs", _`[]`)
        gen.forOf("err", N.vErrors, (err) =>
          gen.if(matchAnyError(err), () =>
            gen.code(_`${errs}.push(${err})`).assign(_`${err}.${used}`, true)
          )
        )
        gen.if(_`${errs}.length`, () => {
          reportError(cxt, {
            message: schMessage, // TODO add template support
            params: () => _`{errors: ${errs}}`,
          })
        })
      }

      function removeUsedErrors(): void {
        const errs = gen.const("emErrs", _`[]`)
        gen.forOf("err", N.vErrors, (err) =>
          gen.if(_`!${err}.${used}`, () =>
            gen.code(_`${errs}.push(${err})`)
          )
        )
        gen.assign(N.vErrors, errs).assign(N.errors, _`${errs}.length`)
      }

      function matchKeywordError(err: Name, kwdErrs: Name): Code {
        return and(
          _`${err}.keyword !== ${keyword}`,
          _`!${err}.${used}`,
          _`${err}.dataPath === ${dataPath}`,
          _`${err}.keyword in ${kwdErrs}`,
          // TODO match the end of the string?
          _`${err}.schemaPath.indexOf(${it.errSchemaPath}) === 0`,
          _`/^\\/[^\\/]*$/.test(${err}.schemaPath.slice(${it.errSchemaPath.length}))`
        )
      }

      function ifMatchesChildError(
        err: Name,
        childErrs: Name,
        thenBody: (child: Name) => void
      ): void {
        gen.if(
          and(
            _`${err}.keyword !== ${keyword}`,
            _`!${err}.${used}`,
            _`${err}.dataPath.indexOf(${dataPath}) === 0`
          ),
          () => {
            const childRegex = gen.scopeValue("pattern", {ref: /^\/([^/]*)(?:\/|$)/})
            const matches = gen.const(
              "emMatches",
              _`${childRegex}.exec(${err}.dataPath.slice(${dataPath}.length))`
            )
            const child = gen.const(
              "emChild",
              _`${matches} && ${matches}[1].replace(/~1/g, "/").replace(/~0/g, "~")`
            )
            gen.if(_`${child} !== undefined && ${child} in ${childErrs}`, () => thenBody(child))
          }
        )
      }

      function matchAnyError(err: Name): Code {
        return and(
          _`${err}.keyword !== ${keyword}`,
          _`!${err}.${used}`,
          or(
            _`${err}.dataPath === ${dataPath}`,
            and(
              _`${err}.dataPath.indexOf(${dataPath}) === 0`,
              _`${err}.dataPath[${dataPath}.length] === "/"`
            )
          ),
          _`${err}.schemaPath.indexOf(${it.errSchemaPath}) === 0`,
          _`${err}.schemaPath[${it.errSchemaPath}.length] === "/"`
        )
      }
    },
    metaSchema: {
      anyOf: [
        {type: "string"},
        {
          type: "object",
          properties: {
            properties: {$ref: "#/$defs/stringMap"},
            items: {$ref: "#/$defs/stringList"},
            required: {$ref: "#/$defs/stringOrMap"},
            dependencies: {$ref: "#/$defs/stringOrMap"},
          },
          additionalProperties: {type: "string"},
        },
      ],
      $defs: {
        stringMap: {
          type: "object",
          additionalProperties: {type: "string"},
        },
        stringOrMap: {
          anyOf: [{type: "string"}, {$ref: "#/$defs/stringMap"}],
        },
        stringList: {type: "array", items: {type: "string"}},
      },
    },
  }
}

const ajvErrors: Plugin<ErrorMessageOptions> = (ajv: Ajv, options: ErrorMessageOptions = {}): Ajv => {
  if (!ajv.opts.allErrors) throw new Error("ajv-errors: Ajv option allErrors must be true")
  if (ajv.opts.jsPropertySyntax)
    {throw new Error("ajv-errors: ajv option jsPropertySyntax is not supported")}
  return ajv.addKeyword(errorMessage(options))
}

export default ajvErrors
module.exports = ajvErrors
module.exports.default = ajvErrors

// module.exports = function (ajv, options) {
//   if (!ajv._opts.allErrors) throw new Error('ajv-errors: Ajv option allErrors must be true');
//   if (!ajv._opts.jsonPointers) {
//     console.warn('ajv-errors: Ajv option jsonPointers changed to true');
//     ajv._opts.jsonPointers = true;
//   }

//   ajv.addKeyword('errorMessage', {
//     inline: require('./lib/dotjs/errorMessage'),
//     statements: true,
//     valid: true,
//     errors: 'full',
//     config: {
//       KEYWORD_PROPERTY_PARAMS: {
//         required: 'missingProperty',
//         dependencies: 'property'
//       },
//       options: options || {}
//     },
//     metaSchema: {
//       'type': ['string', 'object'],
//       properties: {
//         properties: {$ref: '#/$defs/stringMap'},
//         items: {$ref: '#/$defs/stringList'},
//         required: {$ref: '#/$defs/stringOrMap'},
//         dependencies: {$ref: '#/$defs/stringOrMap'}
//       },
//       additionalProperties: {'type': 'string'},
//       $defs: {
//         stringMap: {
//           'type': ['object'],
//           additionalProperties: {'type': 'string'}
//         },
//         stringOrMap: {
//           'type': ['string', 'object'],
//           additionalProperties: {'type': 'string'}
//         },
//         stringList: {
//           'type': ['array'],
//           items: {'type': 'string'}
//         }
//       }
//     }
//   });
//   return ajv;
// };
