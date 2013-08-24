"use strict";
var RouteRecognizer = require("route-recognizer");
var RSVP = require("rsvp");
/**
  @private

  This file references several internal structures:

  ## `RecognizedHandler`

  * `{String} handler`: A handler name
  * `{Object} params`: A hash of recognized parameters

  ## `HandlerInfo`

  * `{Boolean} isDynamic`: whether a handler has any dynamic segments
  * `{String} name`: the name of a handler
  * `{Object} handler`: a handler object
  * `{Object} context`: the active context for the handler
*/


var slice = Array.prototype.slice;



/**
  @private

  A Transition is a thennable (a promise-like object) that represents
  an attempt to transition to another route. It can be aborted, either
  explicitly via `abort` or by attempting another transition while a
  previous one is still underway. An aborted transition can also
  be `retry()`d later.
 */

function Transition(router, promise) {
  this.router = router;
  this.promise = promise;
  this.data = {};
  this.resolvedModels = {};
  this.providedModels = {};
  this.providedModelsArray = [];
  this.sequence = ++Transition.currentSequence;
  this.params = {};
}

Transition.currentSequence = 0;

Transition.prototype = {
  targetName: null,
  urlMethod: 'update',
  providedModels: null,
  resolvedModels: null,
  params: null,

  /**
    The Transition's internal promise. Calling `.then` on this property
    is that same as calling `.then` on the Transition object itself, but
    this property is exposed for when you want to pass around a
    Transition's promise, but not the Transition object itself, since
    Transition object can be externally `abort`ed, while the promise
    cannot.
   */
  promise: null,

  /**
    Custom state can be stored on a Transition's `data` object.
    This can be useful for decorating a Transition within an earlier
    hook and shared with a later hook. Properties set on `data` will
    be copied to new transitions generated by calling `retry` on this
    transition.
   */
  data: null,

  /**
    A standard promise hook that resolves if the transition
    succeeds and rejects if it fails/redirects/aborts.

    Forwards to the internal `promise` property which you can
    use in situations where you want to pass around a thennable,
    but not the Transition itself.

    @param {Function} success
    @param {Function} failure
   */
  then: function(success, failure) {
    return this.promise.then(success, failure);
  },

  /**
    Aborts the Transition. Note you can also implicitly abort a transition
    by initiating another transition while a previous one is underway.
   */
  abort: function() {
    if (this.isAborted) { return this; }
    log(this.router, this.sequence, this.targetName + ": transition was aborted");
    this.isAborted = true;
    this.router.activeTransition = null;
    return this;
  },

  /**
    Retries a previously-aborted transition (making sure to abort the
    transition if it's still active). Returns a new transition that
    represents the new attempt to transition.
   */
  retry: function() {
    this.abort();
    var recogHandlers = this.router.recognizer.handlersFor(this.targetName),
        handlerInfos  = generateHandlerInfosWithQueryParams(this.router, recogHandlers, this.queryParams),
        newTransition = performTransition(this.router, handlerInfos, this.providedModelsArray, this.params, this.queryParams, this.data);

    return newTransition;
  },

  /**
    Sets the URL-changing method to be employed at the end of a
    successful transition. By default, a new Transition will just
    use `updateURL`, but passing 'replace' to this method will
    cause the URL to update using 'replaceWith' instead. Omitting
    a parameter will disable the URL change, allowing for transitions
    that don't update the URL at completion (this is also used for
    handleURL, since the URL has already changed before the
    transition took place).

    @param {String} method the type of URL-changing method to use
      at the end of a transition. Accepted values are 'replace',
      falsy values, or any other non-falsy value (which is
      interpreted as an updateURL transition).

    @return {Transition} this transition
   */
  method: function(method) {
    this.urlMethod = method;
    return this;
  }
};

function Router() {
  this.recognizer = new RouteRecognizer();
}



/**
  Promise reject reasons passed to promise rejection
  handlers for failed transitions.
 */
Router.UnrecognizedURLError = function(message) {
  this.message = (message || "UnrecognizedURLError");
  this.name = "UnrecognizedURLError";
};

Router.TransitionAborted = function(message) {
  this.message = (message || "TransitionAborted");
  this.name = "TransitionAborted";
};

function errorTransition(router, reason) {
  return new Transition(router, RSVP.reject(reason));
}


Router.prototype = {
  /**
    The main entry point into the router. The API is essentially
    the same as the `map` method in `route-recognizer`.

    This method extracts the String handler at the last `.to()`
    call and uses it as the name of the whole route.

    @param {Function} callback
  */
  map: function(callback) {
    this.recognizer.delegate = this.delegate;

    this.recognizer.map(callback, function(recognizer, route) {
      var lastHandler = route[route.length - 1].handler;
      var args = [route, { as: lastHandler }];
      recognizer.add.apply(recognizer, args);
    });
  },

  hasRoute: function(route) {
    return this.recognizer.hasRoute(route);
  },

  /**
    Clears the current and target route handlers and triggers exit
    on each of them starting at the leaf and traversing up through
    its ancestors.
  */
  reset: function() {
    eachHandler(this.currentHandlerInfos || [], function(handlerInfo) {
      var handler = handlerInfo.handler;
      if (handler.exit) {
        handler.exit();
      }
    });
    this.currentHandlerInfos = null;
    this.targetHandlerInfos = null;
  },

  activeTransition: null,

  /**
    var handler = handlerInfo.handler;
    The entry point for handling a change to the URL (usually
    via the back and forward button).

    Returns an Array of handlers and the parameters associated
    with those parameters.

    @param {String} url a URL to process

    @return {Array} an Array of `[handler, parameter]` tuples
  */
  handleURL: function(url) {
    // Perform a URL-based transition, but don't change
    // the URL afterward, since it already happened.
    var args = slice.call(arguments);
    if (url.charAt(0) !== '/') { args[0] = '/' + url; }
    return doTransition(this, args).method(null);
  },

  /**
    Hook point for updating the URL.

    @param {String} url a URL to update to
  */
  updateURL: function() {
    throw new Error("updateURL is not implemented");
  },

  /**
    Hook point for replacing the current URL, i.e. with replaceState

    By default this behaves the same as `updateURL`

    @param {String} url a URL to update to
  */
  replaceURL: function(url) {
    this.updateURL(url);
  },

  /**
    Transition into the specified named route.

    If necessary, trigger the exit callback on any handlers
    that are no longer represented by the target route.

    @param {String} name the name of the route
  */
  transitionTo: function(name) {
    return doTransition(this, arguments);
  },

  /**
    Identical to `transitionTo` except that the current URL will be replaced
    if possible.

    This method is intended primarily for use with `replaceState`.

    @param {String} name the name of the route
  */
  replaceWith: function(name) {
    return doTransition(this, arguments).method('replace');
  },

  /**
    @private

    This method takes a handler name and a list of contexts and returns
    a serialized parameter hash suitable to pass to `recognizer.generate()`.

    @param {String} handlerName
    @param {Array[Object]} contexts
    @return {Object} a serialized parameter hash
  */
  paramsForHandler: function(handlerName) {
    var partitionedArgs = extractQueryParams(slice.call(arguments, 1));
    return paramsForHandler(this, handlerName, partitionedArgs[0], partitionedArgs[1]);
  },

  /**
    This method takes a handler name and returns a list of query params
    that are valid to pass to the handler or its parents

    @param {String} handlerName
    @return {Array[String]} a list of query parameters
  */
  queryParamsForHandler: function (handlerName) {
    return queryParamsForHandler(this, handlerName);
  },

  /**
    Take a named route and context objects and generate a
    URL.

    @param {String} name the name of the route to generate
      a URL for
    @param {...Object} objects a list of objects to serialize

    @return {String} a URL
  */
  generate: function(handlerName) {
    var partitionedArgs = extractQueryParams(slice.call(arguments, 1)),
      suppliedParams = partitionedArgs[0],
      queryParams = partitionedArgs[1];

    var params = paramsForHandler(this, handlerName, suppliedParams, queryParams),
      validQueryParams = queryParamsForHandler(this, handlerName);

    var missingParams = [];

    for (var key in queryParams) {
      if (queryParams.hasOwnProperty(key) && !~validQueryParams.indexOf(key)) {
        missingParams.push(key);
      }
    }

    if (missingParams.length > 0) {
      var err = 'You supplied the params ';
      err += missingParams.map(function(param) {
        return '"' + param + "=" + queryParams[param] + '"';
      }).join(' and ');

      err += ' which are not valid for the "' + handlerName + '" handler or its parents';

      throw new Error(err);
    }

    return this.recognizer.generate(handlerName, params);
  },

  isActive: function(handlerName) {
    var partitionedArgs   = extractQueryParams(slice.call(arguments, 1)),
        contexts          = partitionedArgs[0],
        queryParams       = partitionedArgs[1],
        foundQueryParams  = {};

    var targetHandlerInfos = this.targetHandlerInfos,
        found = false, names, object, handlerInfo, handlerObj;

    if (!targetHandlerInfos) { return false; }

    var recogHandlers = this.recognizer.handlersFor(targetHandlerInfos[targetHandlerInfos.length - 1].name);
    for (var i=targetHandlerInfos.length-1; i>=0; i--) {
      handlerInfo = targetHandlerInfos[i];
      if (handlerInfo.name === handlerName) { found = true; }

      if (found) {
        if (queryParams) { merge(foundQueryParams, handlerInfo.queryParams); }

        if (handlerInfo.isDynamic && contexts.length > 0) {
          object = contexts.pop();

          if (isParam(object)) {
            var recogHandler = recogHandlers[i], name = recogHandler.names[0];
            if (object.toString() !== this.currentParams[name]) { return false; }
          } else if (handlerInfo.context !== object) {
            return false;
          }
        }
      }
    }

    return contexts.length === 0 && found && queryParamsEqual(queryParams, foundQueryParams);
  },

  trigger: function(name) {
    var args = slice.call(arguments);
    trigger(this.currentHandlerInfos, false, args);
  },

  /**
    Hook point for logging transition status updates.

    @param {String} message The message to log.
  */
  log: null
};

/**
  @private

  Used internally for both URL and named transition to determine
  a shared pivot parent route and other data necessary to perform
  a transition.
 */
function getMatchPoint(router, handlers, objects, inputParams, queryParams) {

  var matchPoint = handlers.length,
      providedModels = {}, i,
      currentHandlerInfos = router.currentHandlerInfos || [],
      params = {},
      oldParams = router.currentParams || {},
      activeTransition = router.activeTransition,
      handlerParams = {},
      obj;

  objects = slice.call(objects);
  merge(params, inputParams);

  for (i = handlers.length - 1; i >= 0; i--) {
    var handlerObj = handlers[i],
        handlerName = handlerObj.handler,
        oldHandlerInfo = currentHandlerInfos[i],
        hasChanged = false;

    // Check if handler names have changed.
    if (!oldHandlerInfo || oldHandlerInfo.name !== handlerObj.handler) { hasChanged = true; }

    if (handlerObj.isDynamic) {
      // URL transition.

      if (obj = getMatchPointObject(objects, handlerName, activeTransition, true, params)) {
        hasChanged = true;
        providedModels[handlerName] = obj;
      } else {
        handlerParams[handlerName] = {};
        for (var prop in handlerObj.params) {
          if (!handlerObj.params.hasOwnProperty(prop)) { continue; }
          var newParam = handlerObj.params[prop];
          if (oldParams[prop] !== newParam) { hasChanged = true; }
          handlerParams[handlerName][prop] = params[prop] = newParam;
        }
      }
    } else if (handlerObj.hasOwnProperty('names')) {
      // Named transition.

      if (objects.length) { hasChanged = true; }

      if (obj = getMatchPointObject(objects, handlerName, activeTransition, handlerObj.names[0], params)) {
        providedModels[handlerName] = obj;
      } else {
        var names = handlerObj.names;
        handlerParams[handlerName] = {};
        for (var j = 0, len = names.length; j < len; ++j) {
          var name = names[j];
          handlerParams[handlerName][name] = params[name] = params[name] || oldParams[name];
        }
      }
    }

    // If there is an old handler, see if query params are the same. If there isn't an old handler,
    // hasChanged will already be true here
    if(oldHandlerInfo && !queryParamsEqual(oldHandlerInfo.queryParams, handlerObj.queryParams)) {
        hasChanged = true;
    }

    if (hasChanged) { matchPoint = i; }
  }

  if (objects.length > 0) {
    throw new Error("More context objects were passed than there are dynamic segments for the route: " + handlers[handlers.length - 1].handler);
  }

  return { matchPoint: matchPoint, providedModels: providedModels, params: params, handlerParams: handlerParams };
}

function getMatchPointObject(objects, handlerName, activeTransition, paramName, params) {

  if (objects.length && paramName) {

    var object = objects.pop();

    // If provided object is string or number, treat as param.
    if (isParam(object)) {
      params[paramName] = object.toString();
    } else {
      return object;
    }
  } else if (activeTransition) {
    // Use model from previous transition attempt, preferably the resolved one.
    return activeTransition.resolvedModels[handlerName] ||
           (paramName && activeTransition.providedModels[handlerName]);
  }
}

function isParam(object) {
  return (typeof object === "string" || object instanceof String || !isNaN(object));
}



/**
  @private

  This method takes a handler name and returns a list of query params
  that are valid to pass to the handler or its parents

  @param {Router} router
  @param {String} handlerName
  @return {Array[String]} a list of query parameters
*/
function queryParamsForHandler(router, handlerName) {
  var handlers = router.recognizer.handlersFor(handlerName),
    queryParams = [];

  for (var i = 0; i < handlers.length; i++) {
    queryParams.push.apply(queryParams, handlers[i].queryParams || []);
  }

  return queryParams;
}
/**
  @private

  This method takes a handler name and a list of contexts and returns
  a serialized parameter hash suitable to pass to `recognizer.generate()`.

  @param {Router} router
  @param {String} handlerName
  @param {Array[Object]} objects
  @return {Object} a serialized parameter hash
*/
function paramsForHandler(router, handlerName, objects, queryParams) {

  var handlers = router.recognizer.handlersFor(handlerName),
      params = {},
      handlerInfos = generateHandlerInfosWithQueryParams(router, handlers, queryParams),
      matchPoint = getMatchPoint(router, handlerInfos, objects).matchPoint,
      mergedQueryParams = {},
      object, handlerObj, handler, names, i;

  params.queryParams = {};

  for (i=0; i<handlers.length; i++) {
    handlerObj = handlers[i];
    handler = router.getHandler(handlerObj.handler);
    names = handlerObj.names;

    // If it's a dynamic segment
    if (names.length) {
      // If we have objects, use them
      if (i >= matchPoint) {
        object = objects.shift();
      // Otherwise use existing context
      } else {
        object = handler.context;
      }

      // Serialize to generate params
      merge(params, serialize(handler, object, names));
    }

    mergeSomeKeys(params.queryParams, router.currentQueryParams, handlerObj.queryParams);
    mergeSomeKeys(params.queryParams, queryParams, handlerObj.queryParams);
  }

  if (queryParamsEqual(params.queryParams, {})) { delete params.queryParams; }
  return params;
}

function merge(hash, other) {
  for (var prop in other) {
    if (other.hasOwnProperty(prop)) { hash[prop] = other[prop]; }
  }
}

function mergeSomeKeys(hash, other, keys) {
  if (!other || !keys) { return; }
  for(var i = 0; i < keys.length; i++) {
    var key = keys[i], value;
    if(other.hasOwnProperty(key)) {
      value = other[key];
      if(value === null || value === false || typeof value === "undefined") {
        delete hash[key];
      } else {
        hash[key] = other[key];
      }
    }
  }
}

/**
  @private
*/

function generateHandlerInfosWithQueryParams(router, handlers, queryParams) {
  var handlerInfos = [];

  for (var i = 0; i < handlers.length; i++) {
    var handler = handlers[i],
      handlerInfo = { handler: handler.handler, names: handler.names, context: handler.context, isDynamic: handler.isDynamic },
      activeQueryParams = {};


    mergeSomeKeys(activeQueryParams, router.currentQueryParams, handler.queryParams);
    mergeSomeKeys(activeQueryParams, queryParams, handler.queryParams);

    if (handler.queryParams && handler.queryParams.length > 0) {
      handlerInfo.queryParams = activeQueryParams;
    }

    handlerInfos.push(handlerInfo);
  }

  return handlerInfos;
}

/**
  @private
*/
function createQueryParamTransition(router, queryParams) {
  var currentHandlers = router.currentHandlerInfos,
      currentHandler = currentHandlers[currentHandlers.length - 1],
      name = currentHandler.name;

  log(router, "Attempting query param transition");

  return createNamedTransition(router, [name, queryParams]);
}

/**
  @private
*/
function createNamedTransition(router, args) {
  var partitionedArgs     = extractQueryParams(args),
    pureArgs              = partitionedArgs[0],
    queryParams           = partitionedArgs[1],
    handlers              = router.recognizer.handlersFor(pureArgs[0]),
    handlerInfos          = generateHandlerInfosWithQueryParams(router, handlers, queryParams);


  log(router, "Attempting transition to " + pureArgs[0]);

  return performTransition(router, handlerInfos, slice.call(pureArgs, 1), router.currentParams, queryParams);
}

/**
  @private
*/
function createURLTransition(router, url) {
  var results = router.recognizer.recognize(url),
      currentHandlerInfos = router.currentHandlerInfos,
      queryParams = {};

  log(router, "Attempting URL transition to " + url);

  if (!results) {
    return errorTransition(router, new Router.UnrecognizedURLError(url));
  }

  for(var i = 0; i < results.length; i++) {
    merge(queryParams, results[i].queryParams);
  }

  return performTransition(router, results, [], {}, queryParams);
}


/**
  @private

  Takes an Array of `HandlerInfo`s, figures out which ones are
  exiting, entering, or changing contexts, and calls the
  proper handler hooks.

  For example, consider the following tree of handlers. Each handler is
  followed by the URL segment it handles.

  ```
  |~index ("/")
  | |~posts ("/posts")
  | | |-showPost ("/:id")
  | | |-newPost ("/new")
  | | |-editPost ("/edit")
  | |~about ("/about/:id")
  ```

  Consider the following transitions:

  1. A URL transition to `/posts/1`.
     1. Triggers the `*model` callbacks on the
        `index`, `posts`, and `showPost` handlers
     2. Triggers the `enter` callback on the same
     3. Triggers the `setup` callback on the same
  2. A direct transition to `newPost`
     1. Triggers the `exit` callback on `showPost`
     2. Triggers the `enter` callback on `newPost`
     3. Triggers the `setup` callback on `newPost`
  3. A direct transition to `about` with a specified
     context object
     1. Triggers the `exit` callback on `newPost`
        and `posts`
     2. Triggers the `serialize` callback on `about`
     3. Triggers the `enter` callback on `about`
     4. Triggers the `setup` callback on `about`

  @param {Transition} transition
  @param {Array[HandlerInfo]} handlerInfos
*/
function setupContexts(transition, handlerInfos) {
  var router = transition.router,
      partition = partitionHandlers(router.currentHandlerInfos || [], handlerInfos);

  router.targetHandlerInfos = handlerInfos;

  eachHandler(partition.exited, function(handlerInfo) {
    var handler = handlerInfo.handler;
    delete handler.context;
    if (handler.exit) { handler.exit(); }
  });

  var currentHandlerInfos = partition.unchanged.slice();
  router.currentHandlerInfos = currentHandlerInfos;

  eachHandler(partition.updatedContext, function(handlerInfo) {
    handlerEnteredOrUpdated(transition, currentHandlerInfos, handlerInfo, false);
  });

  eachHandler(partition.entered, function(handlerInfo) {
    handlerEnteredOrUpdated(transition, currentHandlerInfos, handlerInfo, true);
  });
}

/**
  @private

  Helper method used by setupContexts. Handles errors or redirects
  that may happen in enter/setup.
*/
function handlerEnteredOrUpdated(transition, currentHandlerInfos, handlerInfo, enter) {
  var handler = handlerInfo.handler,
      context = handlerInfo.context;

  try {
    if (enter && handler.enter) { handler.enter(); }
    checkAbort(transition);

    setContext(handler, context);
    setQueryParams(handler, handlerInfo.queryParams);

    if (handler.setup) { handler.setup(context, handlerInfo.queryParams); }
    checkAbort(transition);
  } catch(e) {
    if (!(e instanceof Router.TransitionAborted)) {
      // Trigger the `error` event starting from this failed handler.
      trigger(currentHandlerInfos.concat(handlerInfo), true, ['error', e, transition]);
    }

    // Propagate the error so that the transition promise will reject.
    throw e;
  }

  currentHandlerInfos.push(handlerInfo);
}


/**
  @private

  Iterates over an array of `HandlerInfo`s, passing the handler
  and context into the callback.

  @param {Array[HandlerInfo]} handlerInfos
  @param {Function(Object, Object)} callback
*/
function eachHandler(handlerInfos, callback) {
  for (var i=0, l=handlerInfos.length; i<l; i++) {
    callback(handlerInfos[i]);
  }
}

/**
  @private

  determines if two queryparam objects are the same or not
**/
function queryParamsEqual(a, b) {
  a = a || {};
  b = b || {};
  var checkedKeys = [], key;
  for(key in a) {
    if (!a.hasOwnProperty(key)) { continue; }
    if(b[key] !== a[key]) { return false; }
    checkedKeys.push(key);
  }
  for(key in b) {
    if (!b.hasOwnProperty(key)) { continue; }
    if (~checkedKeys.indexOf(key)) { continue; }
    // b has a key not in a
    return false;
  }
  return true;
}

/**
  @private

  This function is called when transitioning from one URL to
  another to determine which handlers are not longer active,
  which handlers are newly active, and which handlers remain
  active but have their context changed.

  Take a list of old handlers and new handlers and partition
  them into four buckets:

  * unchanged: the handler was active in both the old and
    new URL, and its context remains the same
  * updated context: the handler was active in both the
    old and new URL, but its context changed. The handler's
    `setup` method, if any, will be called with the new
    context.
  * exited: the handler was active in the old URL, but is
    no longer active.
  * entered: the handler was not active in the old URL, but
    is now active.

  The PartitionedHandlers structure has four fields:

  * `updatedContext`: a list of `HandlerInfo` objects that
    represent handlers that remain active but have a changed
    context
  * `entered`: a list of `HandlerInfo` objects that represent
    handlers that are newly active
  * `exited`: a list of `HandlerInfo` objects that are no
    longer active.
  * `unchanged`: a list of `HanderInfo` objects that remain active.

  @param {Array[HandlerInfo]} oldHandlers a list of the handler
    information for the previous URL (or `[]` if this is the
    first handled transition)
  @param {Array[HandlerInfo]} newHandlers a list of the handler
    information for the new URL

  @return {Partition}
*/
function partitionHandlers(oldHandlers, newHandlers) {
  var handlers = {
        updatedContext: [],
        exited: [],
        entered: [],
        unchanged: []
      };

  var handlerChanged, contextChanged, queryParamsChanged, i, l;

  for (i=0, l=newHandlers.length; i<l; i++) {
    var oldHandler = oldHandlers[i], newHandler = newHandlers[i];

    if (!oldHandler || oldHandler.handler !== newHandler.handler) {
      handlerChanged = true;
    } else if (!queryParamsEqual(oldHandler.queryParams, newHandler.queryParams)) {
      queryParamsChanged = true;
    }

    if (handlerChanged) {
      handlers.entered.push(newHandler);
      if (oldHandler) { handlers.exited.unshift(oldHandler); }
    } else if (contextChanged || oldHandler.context !== newHandler.context || queryParamsChanged) {
      contextChanged = true;
      handlers.updatedContext.push(newHandler);
    } else {
      handlers.unchanged.push(oldHandler);
    }
  }

  for (i=newHandlers.length, l=oldHandlers.length; i<l; i++) {
    handlers.exited.unshift(oldHandlers[i]);
  }

  return handlers;
}

function trigger(handlerInfos, ignoreFailure, args) {

  var name = args.shift();

  if (!handlerInfos) {
    if (ignoreFailure) { return; }
    throw new Error("Could not trigger event '" + name + "'. There are no active handlers");
  }

  var eventWasHandled = false;

  for (var i=handlerInfos.length-1; i>=0; i--) {
    var handlerInfo = handlerInfos[i],
        handler = handlerInfo.handler;

    if (handler.events && handler.events[name]) {
      if (handler.events[name].apply(handler, args) === true) {
        eventWasHandled = true;
      } else {
        return;
      }
    }
  }

  if (!eventWasHandled && !ignoreFailure) {
    throw new Error("Nothing handled the event '" + name + "'.");
  }
}

function setContext(handler, context) {
  handler.context = context;
  if (handler.contextDidChange) { handler.contextDidChange(); }
}

function setQueryParams(handler, queryParams) {
  handler.queryParams = queryParams;
  if (handler.queryParamsDidChange) { handler.queryParamsDidChange(); }
}


/**
  @private

  Extracts query params from the end of an array
**/

function extractQueryParams(array) {
  var len = (array && array.length), head, queryParams;

  if(len && len > 0 && (queryParams = array[len - 1].queryParams)) {
    head = slice.call(array, 0, len - 1);
    return [head, queryParams];
  } else {
    return [array, null];
  }
}

/**
  @private

  Creates, begins, and returns a Transition.
 */
function performTransition(router, recogHandlers, providedModelsArray, params, queryParams, data) {

  var matchPointResults = getMatchPoint(router, recogHandlers, providedModelsArray, params, queryParams),
      targetName = recogHandlers[recogHandlers.length - 1].handler,
      wasTransitioning = false,
      currentHandlerInfos = router.currentHandlerInfos;

  // Check if there's already a transition underway.
  if (router.activeTransition) {
    if (transitionsIdentical(router.activeTransition, targetName, providedModelsArray, queryParams)) {
      return router.activeTransition;
    }
    router.activeTransition.abort();
    wasTransitioning = true;
  }

  var deferred = RSVP.defer(),
      transition = new Transition(router, deferred.promise);

  transition.targetName = targetName;
  transition.providedModels = matchPointResults.providedModels;
  transition.providedModelsArray = providedModelsArray;
  transition.params = matchPointResults.params;
  transition.data = data || {};
  transition.queryParams = queryParams;
  router.activeTransition = transition;

  var handlerInfos = generateHandlerInfos(router, recogHandlers);

  // Fire 'willTransition' event on current handlers, but don't fire it
  // if a transition was already underway.
  if (!wasTransitioning) {
    trigger(currentHandlerInfos, true, ['willTransition', transition]);
  }

  log(router, transition.sequence, "Beginning validation for transition to " + transition.targetName);
  validateEntry(transition, handlerInfos, 0, matchPointResults.matchPoint, matchPointResults.handlerParams)
               .then(transitionSuccess, transitionFailure);

  return transition;

  function transitionSuccess() {
    checkAbort(transition);

    try {
      log(router, transition.sequence, "Validation succeeded, finalizing transition;");

      // Don't overwrite contexts / update URL if this was a noop transition.
      if (!currentHandlerInfos || !currentHandlerInfos.length ||
          currentHandlerInfos.length !== matchPointResults.matchPoint) {
        finalizeTransition(transition, handlerInfos);
      }

      if (router.didTransition) {
        router.didTransition(handlerInfos);
      }

      log(router, transition.sequence, "TRANSITION COMPLETE.");

      // Resolve with the final handler.
      deferred.resolve(handlerInfos[handlerInfos.length - 1].handler);
    } catch(e) {
      deferred.reject(e);
    }

    // Don't nullify if another transition is underway (meaning
    // there was a transition initiated with enter/setup).
    if (!transition.isAborted) {
      router.activeTransition = null;
    }
  }

  function transitionFailure(reason) {
    deferred.reject(reason);
  }
}

/**
  @private

  Accepts handlers in Recognizer format, either returned from
  recognize() or handlersFor(), and returns unified
  `HandlerInfo`s.
 */
function generateHandlerInfos(router, recogHandlers) {
  var handlerInfos = [];
  for (var i = 0, len = recogHandlers.length; i < len; ++i) {
    var handlerObj = recogHandlers[i],
        isDynamic = handlerObj.isDynamic || (handlerObj.names && handlerObj.names.length);


    var handlerInfo = {
      isDynamic: !!isDynamic,
      name: handlerObj.handler,
      handler: router.getHandler(handlerObj.handler)
    };
    if(handlerObj.queryParams) {
      handlerInfo.queryParams = handlerObj.queryParams;
    }
    handlerInfos.push(handlerInfo);
  }
  return handlerInfos;
}

/**
  @private
 */
function transitionsIdentical(oldTransition, targetName, providedModelsArray, queryParams) {

  if (oldTransition.targetName !== targetName) { return false; }

  var oldModels = oldTransition.providedModelsArray;
  if (oldModels.length !== providedModelsArray.length) { return false; }

  for (var i = 0, len = oldModels.length; i < len; ++i) {
    if (oldModels[i] !== providedModelsArray[i]) { return false; }
  }

  if(!queryParamsEqual(oldTransition.queryParams, queryParams)) {
    return false;
  }

  return true;
}

/**
  @private

  Updates the URL (if necessary) and calls `setupContexts`
  to update the router's array of `currentHandlerInfos`.
 */
function finalizeTransition(transition, handlerInfos) {

  var router = transition.router,
      seq = transition.sequence,
      handlerName = handlerInfos[handlerInfos.length - 1].name,
      i;

  // Collect params for URL.
  var objects = [], providedModels = transition.providedModelsArray.slice();
  for (i = handlerInfos.length - 1; i>=0; --i) {
    var handlerInfo = handlerInfos[i];
    if (handlerInfo.isDynamic) {
      var providedModel = providedModels.pop();
      objects.unshift(isParam(providedModel) ? providedModel.toString() : handlerInfo.context);
    }
  }

  var params = paramsForHandler(router, handlerName, objects, transition.queryParams);

  transition.providedModelsArray = [];
  transition.providedContexts = {};
  router.currentParams = params;

  var newQueryParams = {};
  for (i = handlerInfos.length - 1; i>=0; --i) {
    merge(newQueryParams, handlerInfos[i].queryParams);
  }
  router.currentQueryParams = newQueryParams;

  var urlMethod = transition.urlMethod;
  if (urlMethod) {
    var url = router.recognizer.generate(handlerName, params);

    if (urlMethod === 'replace') {
      router.replaceURL(url);
    } else {
      // Assume everything else is just a URL update for now.
      router.updateURL(url);
    }
  }

  setupContexts(transition, handlerInfos);
}

/**
  @private

  Internal function used to construct the chain of promises used
  to validate a transition. Wraps calls to `beforeModel`, `model`,
  and `afterModel` in promises, and checks for redirects/aborts
  between each.
 */
function validateEntry(transition, handlerInfos, index, matchPoint, handlerParams) {

  if (index === handlerInfos.length) {
    // No more contexts to resolve.
    return RSVP.resolve(transition.resolvedModels);
  }

  var router = transition.router,
      handlerInfo = handlerInfos[index],
      handler = handlerInfo.handler,
      handlerName = handlerInfo.name,
      seq = transition.sequence;

  if (index < matchPoint) {
    log(router, seq, handlerName + ": using context from already-active handler");

    // We're before the match point, so don't run any hooks,
    // just use the already resolved context from the handler.
    transition.resolvedModels[handlerInfo.name] =
      transition.providedModels[handlerInfo.name] ||
      handlerInfo.handler.context;
    return proceed();
  }

  return RSVP.resolve().then(handleAbort)
                       .then(beforeModel)
                       .then(handleAbort)
                       .then(model)
                       .then(handleAbort)
                       .then(afterModel)
                       .then(handleAbort)
                       .then(proceed)
                       .then(null, handleError);

  function handleAbort(result) {
    if (transition.isAborted) {
      log(transition.router, transition.sequence, "detected abort.");
      return RSVP.reject(new Router.TransitionAborted());
    }

    return result;
  }

  function handleError(reason) {
    if (reason instanceof Router.TransitionAborted) {
      // if the transition was aborted and *no additional* error was thrown,
      // reject with the Router.TransitionAborted instance
      return RSVP.reject(reason);
    }

    // otherwise, we're here because of a different error
    transition.abort();

    log(router, seq, handlerName + ": handling error: " + reason);

    // An error was thrown / promise rejected, so fire an
    // `error` event from this handler info up to root.
    trigger(handlerInfos.slice(0, index + 1), true, ['error', reason, transition]);

    if (handler.error) {
      handler.error(reason, transition);
    }

    // Propagate the original error.
    return RSVP.reject(reason);
  }

  function beforeModel() {

    log(router, seq, handlerName + ": calling beforeModel hook");

    var p = handler.beforeModel && handler.beforeModel(transition, handlerInfo.queryParams);
    return (p instanceof Transition) ? null : p;
  }

  function model() {
    log(router, seq, handlerName + ": resolving model");
    var p = getModel(handlerInfo, transition, handlerParams[handlerName], index >= matchPoint);
    return (p instanceof Transition) ? null : p;
  }

  function afterModel(context) {

    log(router, seq, handlerName + ": calling afterModel hook");

    // Pass the context and resolved parent contexts to afterModel, but we don't
    // want to use the value returned from `afterModel` in any way, but rather
    // always resolve with the original `context` object.

    transition.resolvedModels[handlerInfo.name] = context;

    var p = handler.afterModel && handler.afterModel(context, transition, handlerInfo.queryParams);
    return (p instanceof Transition) ? null : p;
  }

  function proceed() {
    log(router, seq, handlerName + ": validation succeeded, proceeding");

    handlerInfo.context = transition.resolvedModels[handlerInfo.name];
    return validateEntry(transition, handlerInfos, index + 1, matchPoint, handlerParams);
  }
}

/**
  @private

  Throws a TransitionAborted if the provided transition has been aborted.
 */
function checkAbort(transition) {
  if (transition.isAborted) {
    log(transition.router, transition.sequence, "detected abort.");
    throw new Router.TransitionAborted();
  }
}

/**
  @private

  Encapsulates the logic for whether to call `model` on a route,
  or use one of the models provided to `transitionTo`.
 */
function getModel(handlerInfo, transition, handlerParams, needsUpdate) {
  var handler = handlerInfo.handler,
      handlerName = handlerInfo.name;

  if (!needsUpdate && handler.hasOwnProperty('context')) {
    return handler.context;
  }

  if (transition.providedModels.hasOwnProperty(handlerName)) {
    var providedModel = transition.providedModels[handlerName];
    return typeof providedModel === 'function' ? providedModel() : providedModel;
  }
  return handler.model && handler.model(handlerParams || {}, transition, handlerInfo.queryParams);
}

/**
  @private
 */
function log(router, sequence, msg) {

  if (!router.log) { return; }

  if (arguments.length === 3) {
    router.log("Transition #" + sequence + ": " + msg);
  } else {
    msg = sequence;
    router.log(msg);
  }
}

/**
  @private

  Begins and returns a Transition based on the provided
  arguments. Accepts arguments in the form of both URL
  transitions and named transitions.

  @param {Router} router
  @param {Array[Object]} args arguments passed to transitionTo,
    replaceWith, or handleURL
*/
function doTransition(router, args) {
  // Normalize blank transitions to root URL transitions.
  var name = args[0] || '/';

  if(args.length === 1 && args[0].queryParams) {
    return createQueryParamTransition(router, args[0]);
  } else if (name.charAt(0) === '/') {
    return createURLTransition(router, name);
  } else {
    return createNamedTransition(router, slice.call(args));
  }
}

/**
  @private

  Serializes a handler using its custom `serialize` method or
  by a default that looks up the expected property name from
  the dynamic segment.

  @param {Object} handler a router handler
  @param {Object} model the model to be serialized for this handler
  @param {Array[Object]} names the names array attached to an
    handler object returned from router.recognizer.handlersFor()
*/
function serialize(handler, model, names) {

  var object = {};
  if (isParam(model)) {
    object[names[0]] = model;
    return object;
  }

  // Use custom serialize if it exists.
  if (handler.serialize) {
    return handler.serialize(model, names);
  }

  if (names.length !== 1) { return; }

  var name = names[0];

  if (/_id$/.test(name)) {
    object[name] = model.id;
  } else {
    object[name] = model;
  }
  return object;
}


module.exports = Router;
