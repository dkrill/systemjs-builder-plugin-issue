"format global";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if ((typeof exports == 'object' || typeof exports == 'function') && exports !== global) {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    // node core modules
    if (name.substr(0, 6) == '@node/')
      return require(name.substr(6));

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['1'], [], function($__System) {

$__System.registerDynamic("2", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  var currentQueue;
  var queueIndex = -1;
  function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
      queue = currentQueue.concat(queue);
    } else {
      queueIndex = -1;
    }
    if (queue.length) {
      drainQueue();
    }
  }
  function drainQueue() {
    if (draining) {
      return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex].run();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
  }
  process.nextTick = function(fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue, 0);
    }
  };
  function Item(fun, array) {
    this.fun = fun;
    this.array = array;
  }
  Item.prototype.run = function() {
    this.fun.apply(null, this.array);
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3", ["2"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('2');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4", ["3"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? process : $__require('3');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5", ["4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('4');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6", ["5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function(process) {
    (function(root, factory) {
      if (typeof define === 'function' && define.amd && define.amd.dust === true) {
        define('dust.core', [], factory);
      } else if (typeof exports === 'object') {
        module.exports = factory();
      } else {
        root.dust = factory();
      }
    }(this, function() {
      var dust = {"version": "2.7.2"},
          NONE = 'NONE',
          ERROR = 'ERROR',
          WARN = 'WARN',
          INFO = 'INFO',
          DEBUG = 'DEBUG',
          EMPTY_FUNC = function() {};
      dust.config = {
        whitespace: false,
        amd: false,
        cjs: false,
        cache: true
      };
      dust._aliases = {
        "write": "w",
        "end": "e",
        "map": "m",
        "render": "r",
        "reference": "f",
        "section": "s",
        "exists": "x",
        "notexists": "nx",
        "block": "b",
        "partial": "p",
        "helper": "h"
      };
      (function initLogging() {
        var loggingLevels = {
          DEBUG: 0,
          INFO: 1,
          WARN: 2,
          ERROR: 3,
          NONE: 4
        },
            consoleLog,
            log;
        if (typeof console !== 'undefined' && console.log) {
          consoleLog = console.log;
          if (typeof consoleLog === 'function') {
            log = function() {
              consoleLog.apply(console, arguments);
            };
          } else {
            log = function() {
              consoleLog(Array.prototype.slice.apply(arguments).join(' '));
            };
          }
        } else {
          log = EMPTY_FUNC;
        }
        dust.log = function(message, type) {
          type = type || INFO;
          if (loggingLevels[type] >= loggingLevels[dust.debugLevel]) {
            log('[DUST:' + type + ']', message);
          }
        };
        dust.debugLevel = NONE;
        if (typeof process !== 'undefined' && process.env && /\bdust\b/.test(process.env.DEBUG)) {
          dust.debugLevel = DEBUG;
        }
      }());
      dust.helpers = {};
      dust.cache = {};
      dust.register = function(name, tmpl) {
        if (!name) {
          return;
        }
        tmpl.templateName = name;
        if (dust.config.cache !== false) {
          dust.cache[name] = tmpl;
        }
      };
      dust.render = function(nameOrTemplate, context, callback) {
        var chunk = new Stub(callback).head;
        try {
          load(nameOrTemplate, chunk, context).end();
        } catch (err) {
          chunk.setError(err);
        }
      };
      dust.stream = function(nameOrTemplate, context) {
        var stream = new Stream(),
            chunk = stream.head;
        dust.nextTick(function() {
          try {
            load(nameOrTemplate, chunk, context).end();
          } catch (err) {
            chunk.setError(err);
          }
        });
        return stream;
      };
      function getTemplate(nameOrTemplate, loadFromCache) {
        if (!nameOrTemplate) {
          return;
        }
        if (typeof nameOrTemplate === 'function' && nameOrTemplate.template) {
          return nameOrTemplate.template;
        }
        if (dust.isTemplateFn(nameOrTemplate)) {
          return nameOrTemplate;
        }
        if (loadFromCache !== false) {
          return dust.cache[nameOrTemplate];
        }
      }
      function load(nameOrTemplate, chunk, context) {
        if (!nameOrTemplate) {
          return chunk.setError(new Error('No template or template name provided to render'));
        }
        var template = getTemplate(nameOrTemplate, dust.config.cache);
        if (template) {
          return template(chunk, Context.wrap(context, template.templateName));
        } else {
          if (dust.onLoad) {
            return chunk.map(function(chunk) {
              var name = nameOrTemplate;
              function done(err, srcOrTemplate) {
                var template;
                if (err) {
                  return chunk.setError(err);
                }
                template = getTemplate(srcOrTemplate, false) || getTemplate(name, dust.config.cache);
                if (!template) {
                  if (dust.compile) {
                    template = dust.loadSource(dust.compile(srcOrTemplate, name));
                  } else {
                    return chunk.setError(new Error('Dust compiler not available'));
                  }
                }
                template(chunk, Context.wrap(context, template.templateName)).end();
              }
              if (dust.onLoad.length === 3) {
                dust.onLoad(name, context.options, done);
              } else {
                dust.onLoad(name, done);
              }
            });
          }
          return chunk.setError(new Error('Template Not Found: ' + nameOrTemplate));
        }
      }
      dust.loadSource = function(source) {
        return eval(source);
      };
      if (Array.isArray) {
        dust.isArray = Array.isArray;
      } else {
        dust.isArray = function(arr) {
          return Object.prototype.toString.call(arr) === '[object Array]';
        };
      }
      dust.nextTick = (function() {
        return function(callback) {
          setTimeout(callback, 0);
        };
      })();
      dust.isEmpty = function(value) {
        if (value === 0) {
          return false;
        }
        if (dust.isArray(value) && !value.length) {
          return true;
        }
        return !value;
      };
      dust.isEmptyObject = function(obj) {
        var key;
        if (obj === null) {
          return false;
        }
        if (obj === undefined) {
          return false;
        }
        if (obj.length > 0) {
          return false;
        }
        for (key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            return false;
          }
        }
        return true;
      };
      dust.isTemplateFn = function(elem) {
        return typeof elem === 'function' && elem.__dustBody;
      };
      dust.isThenable = function(elem) {
        return elem && typeof elem === 'object' && typeof elem.then === 'function';
      };
      dust.isStreamable = function(elem) {
        return elem && typeof elem.on === 'function' && typeof elem.pipe === 'function';
      };
      dust.filter = function(string, auto, filters, context) {
        var i,
            len,
            name,
            filter;
        if (filters) {
          for (i = 0, len = filters.length; i < len; i++) {
            name = filters[i];
            if (!name.length) {
              continue;
            }
            filter = dust.filters[name];
            if (name === 's') {
              auto = null;
            } else if (typeof filter === 'function') {
              string = filter(string, context);
            } else {
              dust.log('Invalid filter `' + name + '`', WARN);
            }
          }
        }
        if (auto) {
          string = dust.filters[auto](string, context);
        }
        return string;
      };
      dust.filters = {
        h: function(value) {
          return dust.escapeHtml(value);
        },
        j: function(value) {
          return dust.escapeJs(value);
        },
        u: encodeURI,
        uc: encodeURIComponent,
        js: function(value) {
          return dust.escapeJSON(value);
        },
        jp: function(value) {
          if (!JSON) {
            dust.log('JSON is undefined; could not parse `' + value + '`', WARN);
            return value;
          } else {
            return JSON.parse(value);
          }
        }
      };
      function Context(stack, global, options, blocks, templateName) {
        if (stack !== undefined && !(stack instanceof Stack)) {
          stack = new Stack(stack);
        }
        this.stack = stack;
        this.global = global;
        this.options = options;
        this.blocks = blocks;
        this.templateName = templateName;
      }
      dust.makeBase = dust.context = function(global, options) {
        return new Context(undefined, global, options);
      };
      function getWithResolvedData(ctx, cur, down) {
        return function(data) {
          return ctx.push(data)._get(cur, down);
        };
      }
      Context.wrap = function(context, name) {
        if (context instanceof Context) {
          return context;
        }
        return new Context(context, {}, {}, null, name);
      };
      Context.prototype.get = function(path, cur) {
        if (typeof path === 'string') {
          if (path[0] === '.') {
            cur = true;
            path = path.substr(1);
          }
          path = path.split('.');
        }
        return this._get(cur, path);
      };
      Context.prototype._get = function(cur, down) {
        var ctx = this.stack || {},
            i = 1,
            value,
            first,
            len,
            ctxThis,
            fn;
        first = down[0];
        len = down.length;
        if (cur && len === 0) {
          ctxThis = ctx;
          ctx = ctx.head;
        } else {
          if (!cur) {
            while (ctx) {
              if (ctx.isObject) {
                ctxThis = ctx.head;
                value = ctx.head[first];
                if (value !== undefined) {
                  break;
                }
              }
              ctx = ctx.tail;
            }
            if (value !== undefined) {
              ctx = value;
            } else {
              ctx = this.global && this.global[first];
            }
          } else if (ctx) {
            if (ctx.head) {
              ctx = ctx.head[first];
            } else {
              ctx = undefined;
            }
          }
          while (ctx && i < len) {
            if (dust.isThenable(ctx)) {
              return ctx.then(getWithResolvedData(this, cur, down.slice(i)));
            }
            ctxThis = ctx;
            ctx = ctx[down[i]];
            i++;
          }
        }
        if (typeof ctx === 'function') {
          fn = function() {
            try {
              return ctx.apply(ctxThis, arguments);
            } catch (err) {
              dust.log(err, ERROR);
              throw err;
            }
          };
          fn.__dustBody = !!ctx.__dustBody;
          return fn;
        } else {
          if (ctx === undefined) {
            dust.log('Cannot find reference `{' + down.join('.') + '}` in template `' + this.getTemplateName() + '`', INFO);
          }
          return ctx;
        }
      };
      Context.prototype.getPath = function(cur, down) {
        return this._get(cur, down);
      };
      Context.prototype.push = function(head, idx, len) {
        if (head === undefined) {
          dust.log("Not pushing an undefined variable onto the context", INFO);
          return this;
        }
        return this.rebase(new Stack(head, this.stack, idx, len));
      };
      Context.prototype.pop = function() {
        var head = this.current();
        this.stack = this.stack && this.stack.tail;
        return head;
      };
      Context.prototype.rebase = function(head) {
        return new Context(head, this.global, this.options, this.blocks, this.getTemplateName());
      };
      Context.prototype.clone = function() {
        var context = this.rebase();
        context.stack = this.stack;
        return context;
      };
      Context.prototype.current = function() {
        return this.stack && this.stack.head;
      };
      Context.prototype.getBlock = function(key) {
        var blocks,
            len,
            fn;
        if (typeof key === 'function') {
          key = key(new Chunk(), this).data.join('');
        }
        blocks = this.blocks;
        if (!blocks) {
          dust.log('No blocks for context `' + key + '` in template `' + this.getTemplateName() + '`', DEBUG);
          return false;
        }
        len = blocks.length;
        while (len--) {
          fn = blocks[len][key];
          if (fn) {
            return fn;
          }
        }
        dust.log('Malformed template `' + this.getTemplateName() + '` was missing one or more blocks.');
        return false;
      };
      Context.prototype.shiftBlocks = function(locals) {
        var blocks = this.blocks,
            newBlocks;
        if (locals) {
          if (!blocks) {
            newBlocks = [locals];
          } else {
            newBlocks = blocks.concat([locals]);
          }
          return new Context(this.stack, this.global, this.options, newBlocks, this.getTemplateName());
        }
        return this;
      };
      Context.prototype.resolve = function(body) {
        var chunk;
        if (typeof body !== 'function') {
          return body;
        }
        chunk = new Chunk().render(body, this);
        if (chunk instanceof Chunk) {
          return chunk.data.join('');
        }
        return chunk;
      };
      Context.prototype.getTemplateName = function() {
        return this.templateName;
      };
      function Stack(head, tail, idx, len) {
        this.tail = tail;
        this.isObject = head && typeof head === 'object';
        this.head = head;
        this.index = idx;
        this.of = len;
      }
      function Stub(callback) {
        this.head = new Chunk(this);
        this.callback = callback;
        this.out = '';
      }
      Stub.prototype.flush = function() {
        var chunk = this.head;
        while (chunk) {
          if (chunk.flushable) {
            this.out += chunk.data.join('');
          } else if (chunk.error) {
            this.callback(chunk.error);
            dust.log('Rendering failed with error `' + chunk.error + '`', ERROR);
            this.flush = EMPTY_FUNC;
            return;
          } else {
            return;
          }
          chunk = chunk.next;
          this.head = chunk;
        }
        this.callback(null, this.out);
      };
      function Stream() {
        this.head = new Chunk(this);
      }
      Stream.prototype.flush = function() {
        var chunk = this.head;
        while (chunk) {
          if (chunk.flushable) {
            this.emit('data', chunk.data.join(''));
          } else if (chunk.error) {
            this.emit('error', chunk.error);
            this.emit('end');
            dust.log('Streaming failed with error `' + chunk.error + '`', ERROR);
            this.flush = EMPTY_FUNC;
            return;
          } else {
            return;
          }
          chunk = chunk.next;
          this.head = chunk;
        }
        this.emit('end');
      };
      Stream.prototype.emit = function(type, data) {
        var events = this.events || {},
            handlers = events[type] || [],
            i,
            l;
        if (!handlers.length) {
          dust.log('Stream broadcasting, but no listeners for `' + type + '`', DEBUG);
          return false;
        }
        handlers = handlers.slice(0);
        for (i = 0, l = handlers.length; i < l; i++) {
          handlers[i](data);
        }
        return true;
      };
      Stream.prototype.on = function(type, callback) {
        var events = this.events = this.events || {},
            handlers = events[type] = events[type] || [];
        if (typeof callback !== 'function') {
          dust.log('No callback function provided for `' + type + '` event listener', WARN);
        } else {
          handlers.push(callback);
        }
        return this;
      };
      Stream.prototype.pipe = function(stream) {
        if (typeof stream.write !== 'function' || typeof stream.end !== 'function') {
          dust.log('Incompatible stream passed to `pipe`', WARN);
          return this;
        }
        var destEnded = false;
        if (typeof stream.emit === 'function') {
          stream.emit('pipe', this);
        }
        if (typeof stream.on === 'function') {
          stream.on('error', function() {
            destEnded = true;
          });
        }
        return this.on('data', function(data) {
          if (destEnded) {
            return;
          }
          try {
            stream.write(data, 'utf8');
          } catch (err) {
            dust.log(err, ERROR);
          }
        }).on('end', function() {
          if (destEnded) {
            return;
          }
          try {
            stream.end();
            destEnded = true;
          } catch (err) {
            dust.log(err, ERROR);
          }
        });
      };
      function Chunk(root, next, taps) {
        this.root = root;
        this.next = next;
        this.data = [];
        this.flushable = false;
        this.taps = taps;
      }
      Chunk.prototype.write = function(data) {
        var taps = this.taps;
        if (taps) {
          data = taps.go(data);
        }
        this.data.push(data);
        return this;
      };
      Chunk.prototype.end = function(data) {
        if (data) {
          this.write(data);
        }
        this.flushable = true;
        this.root.flush();
        return this;
      };
      Chunk.prototype.map = function(callback) {
        var cursor = new Chunk(this.root, this.next, this.taps),
            branch = new Chunk(this.root, cursor, this.taps);
        this.next = branch;
        this.flushable = true;
        try {
          callback(branch);
        } catch (err) {
          dust.log(err, ERROR);
          branch.setError(err);
        }
        return cursor;
      };
      Chunk.prototype.tap = function(tap) {
        var taps = this.taps;
        if (taps) {
          this.taps = taps.push(tap);
        } else {
          this.taps = new Tap(tap);
        }
        return this;
      };
      Chunk.prototype.untap = function() {
        this.taps = this.taps.tail;
        return this;
      };
      Chunk.prototype.render = function(body, context) {
        return body(this, context);
      };
      Chunk.prototype.reference = function(elem, context, auto, filters) {
        if (typeof elem === 'function') {
          elem = elem.apply(context.current(), [this, context, null, {
            auto: auto,
            filters: filters
          }]);
          if (elem instanceof Chunk) {
            return elem;
          } else {
            return this.reference(elem, context, auto, filters);
          }
        }
        if (dust.isThenable(elem)) {
          return this.await(elem, context, null, auto, filters);
        } else if (dust.isStreamable(elem)) {
          return this.stream(elem, context, null, auto, filters);
        } else if (!dust.isEmpty(elem)) {
          return this.write(dust.filter(elem, auto, filters, context));
        } else {
          return this;
        }
      };
      Chunk.prototype.section = function(elem, context, bodies, params) {
        var body = bodies.block,
            skip = bodies['else'],
            chunk = this,
            i,
            len,
            head;
        if (typeof elem === 'function' && !dust.isTemplateFn(elem)) {
          try {
            elem = elem.apply(context.current(), [this, context, bodies, params]);
          } catch (err) {
            dust.log(err, ERROR);
            return this.setError(err);
          }
          if (elem instanceof Chunk) {
            return elem;
          }
        }
        if (dust.isEmptyObject(bodies)) {
          return chunk;
        }
        if (!dust.isEmptyObject(params)) {
          context = context.push(params);
        }
        if (dust.isArray(elem)) {
          if (body) {
            len = elem.length;
            if (len > 0) {
              head = context.stack && context.stack.head || {};
              head.$len = len;
              for (i = 0; i < len; i++) {
                head.$idx = i;
                chunk = body(chunk, context.push(elem[i], i, len));
              }
              head.$idx = undefined;
              head.$len = undefined;
              return chunk;
            } else if (skip) {
              return skip(this, context);
            }
          }
        } else if (dust.isThenable(elem)) {
          return this.await(elem, context, bodies);
        } else if (dust.isStreamable(elem)) {
          return this.stream(elem, context, bodies);
        } else if (elem === true) {
          if (body) {
            return body(this, context);
          }
        } else if (elem || elem === 0) {
          if (body) {
            return body(this, context.push(elem));
          }
        } else if (skip) {
          return skip(this, context);
        }
        dust.log('Section without corresponding key in template `' + context.getTemplateName() + '`', DEBUG);
        return this;
      };
      Chunk.prototype.exists = function(elem, context, bodies) {
        var body = bodies.block,
            skip = bodies['else'];
        if (!dust.isEmpty(elem)) {
          if (body) {
            return body(this, context);
          }
          dust.log('No block for exists check in template `' + context.getTemplateName() + '`', DEBUG);
        } else if (skip) {
          return skip(this, context);
        }
        return this;
      };
      Chunk.prototype.notexists = function(elem, context, bodies) {
        var body = bodies.block,
            skip = bodies['else'];
        if (dust.isEmpty(elem)) {
          if (body) {
            return body(this, context);
          }
          dust.log('No block for not-exists check in template `' + context.getTemplateName() + '`', DEBUG);
        } else if (skip) {
          return skip(this, context);
        }
        return this;
      };
      Chunk.prototype.block = function(elem, context, bodies) {
        var body = elem || bodies.block;
        if (body) {
          return body(this, context);
        }
        return this;
      };
      Chunk.prototype.partial = function(elem, context, partialContext, params) {
        var head;
        if (params === undefined) {
          params = partialContext;
          partialContext = context;
        }
        if (!dust.isEmptyObject(params)) {
          partialContext = partialContext.clone();
          head = partialContext.pop();
          partialContext = partialContext.push(params).push(head);
        }
        if (dust.isTemplateFn(elem)) {
          return this.capture(elem, context, function(name, chunk) {
            partialContext.templateName = name;
            load(name, chunk, partialContext).end();
          });
        } else {
          partialContext.templateName = elem;
          return load(elem, this, partialContext);
        }
      };
      Chunk.prototype.helper = function(name, context, bodies, params, auto) {
        var chunk = this,
            filters = params.filters,
            ret;
        if (auto === undefined) {
          auto = 'h';
        }
        if (dust.helpers[name]) {
          try {
            ret = dust.helpers[name](chunk, context, bodies, params);
            if (ret instanceof Chunk) {
              return ret;
            }
            if (typeof filters === 'string') {
              filters = filters.split('|');
            }
            if (!dust.isEmptyObject(bodies)) {
              return chunk.section(ret, context, bodies, params);
            }
            return chunk.reference(ret, context, auto, filters);
          } catch (err) {
            dust.log('Error in helper `' + name + '`: ' + err.message, ERROR);
            return chunk.setError(err);
          }
        } else {
          dust.log('Helper `' + name + '` does not exist', WARN);
          return chunk;
        }
      };
      Chunk.prototype.await = function(thenable, context, bodies, auto, filters) {
        return this.map(function(chunk) {
          thenable.then(function(data) {
            if (bodies) {
              chunk = chunk.section(data, context, bodies);
            } else {
              chunk = chunk.reference(data, context, auto, filters);
            }
            chunk.end();
          }, function(err) {
            var errorBody = bodies && bodies.error;
            if (errorBody) {
              chunk.render(errorBody, context.push(err)).end();
            } else {
              dust.log('Unhandled promise rejection in `' + context.getTemplateName() + '`', INFO);
              chunk.end();
            }
          });
        });
      };
      Chunk.prototype.stream = function(stream, context, bodies, auto, filters) {
        var body = bodies && bodies.block,
            errorBody = bodies && bodies.error;
        return this.map(function(chunk) {
          var ended = false;
          stream.on('data', function data(thunk) {
            if (ended) {
              return;
            }
            if (body) {
              chunk = chunk.map(function(chunk) {
                chunk.render(body, context.push(thunk)).end();
              });
            } else if (!bodies) {
              chunk = chunk.reference(thunk, context, auto, filters);
            }
          }).on('error', function error(err) {
            if (ended) {
              return;
            }
            if (errorBody) {
              chunk.render(errorBody, context.push(err));
            } else {
              dust.log('Unhandled stream error in `' + context.getTemplateName() + '`', INFO);
            }
            if (!ended) {
              ended = true;
              chunk.end();
            }
          }).on('end', function end() {
            if (!ended) {
              ended = true;
              chunk.end();
            }
          });
        });
      };
      Chunk.prototype.capture = function(body, context, callback) {
        return this.map(function(chunk) {
          var stub = new Stub(function(err, out) {
            if (err) {
              chunk.setError(err);
            } else {
              callback(out, chunk);
            }
          });
          body(stub.head, context).end();
        });
      };
      Chunk.prototype.setError = function(err) {
        this.error = err;
        this.root.flush();
        return this;
      };
      for (var f in Chunk.prototype) {
        if (dust._aliases[f]) {
          Chunk.prototype[dust._aliases[f]] = Chunk.prototype[f];
        }
      }
      function Tap(head, tail) {
        this.head = head;
        this.tail = tail;
      }
      Tap.prototype.push = function(tap) {
        return new Tap(tap, this);
      };
      Tap.prototype.go = function(value) {
        var tap = this;
        while (tap) {
          value = tap.head(value);
          tap = tap.tail;
        }
        return value;
      };
      var HCHARS = /[&<>"']/,
          AMP = /&/g,
          LT = /</g,
          GT = />/g,
          QUOT = /\"/g,
          SQUOT = /\'/g;
      dust.escapeHtml = function(s) {
        if (typeof s === "string" || (s && typeof s.toString === "function")) {
          if (typeof s !== "string") {
            s = s.toString();
          }
          if (!HCHARS.test(s)) {
            return s;
          }
          return s.replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;').replace(QUOT, '&quot;').replace(SQUOT, '&#39;');
        }
        return s;
      };
      var BS = /\\/g,
          FS = /\//g,
          CR = /\r/g,
          LS = /\u2028/g,
          PS = /\u2029/g,
          NL = /\n/g,
          LF = /\f/g,
          SQ = /'/g,
          DQ = /"/g,
          TB = /\t/g;
      dust.escapeJs = function(s) {
        if (typeof s === 'string') {
          return s.replace(BS, '\\\\').replace(FS, '\\/').replace(DQ, '\\"').replace(SQ, '\\\'').replace(CR, '\\r').replace(LS, '\\u2028').replace(PS, '\\u2029').replace(NL, '\\n').replace(LF, '\\f').replace(TB, '\\t');
        }
        return s;
      };
      dust.escapeJSON = function(o) {
        if (!JSON) {
          dust.log('JSON is undefined; could not escape `' + o + '`', WARN);
          return o;
        } else {
          return JSON.stringify(o).replace(LS, '\\u2028').replace(PS, '\\u2029').replace(LT, '\\u003c');
        }
      };
      return dust;
    }));
  })($__require('5'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7", ["6"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('6');
  global.define = __define;
  return module.exports;
});

$__System.register("8", ["7"], function (_export) {
  "use strict";

  var dust;
  return {
    setters: [function (_) {
      dust = _["default"];
    }],
    execute: function () {
      (function (dust) {
        dust.register("main", body_0);function body_0(chk, ctx) {
          return chk.w("<div>Hello World</div>");
        }body_0.__dustBody = !0;return body_0;
      })(dust);
      _export("default", "main");
    }
  };
});

$__System.register('1', ['8'], function (_export) {
  'use strict';

  var template;
  return {
    setters: [function (_) {
      template = _['default'];
    }],
    execute: function () {
      _export('default', function () {
        return template;
      });
    }
  };
});

})
(function(factory) {
  factory();
});