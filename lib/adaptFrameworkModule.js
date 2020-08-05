const _ = require('lodash');
const fs = require('fs-extra');
const glob = require('util').promisify(require('glob'));
const path = require('path');

const { AbstractModule } = require('adapt-authoring-core');

const FWUtils = require('./adaptFrameworkUtils');
/**
* Module to handle the interface with the Adapt framework
* @extends {AbstractModule}
*/
class AdaptFrameworkModule extends AbstractModule {
  /** @override */
  constructor(...args) {
    super(...args);
    this.init();
  }
  /**
  * Initialises the module
  * @return {Promise}
  */
  async init() {
    await this.initFramework();
    await this.loadSchemas();
    await this.initRoutes();

    const content = await this.app.waitForModule('content');
    content.accessCheckHook.tap(this.checkContentAccess.bind(this));

    this.setReady();
  }
  /**
  * Initialises a local copy of the Adapt framework
  * @return {Promise}
  */
  async initFramework() {
    /**
    * Location of the local Adapt framework files
    * @type {String}
    */
    this.path = path.join(this.app.getConfig('tempDir'), 'adapt_framework');
    try {
      await fs.stat(this.path);
      this.log('debug', 'existing local adapt_framework found');
    } catch(e) {
      this.log('debug', 'no local adapt_framework found, initialising');
      await FWUtils.createLocalFramework(this.path);
      this.log('debug', 'local adapt_framework initialised');
    }
    /**
    * Cached package.json data for the local framework copy
    * @type {Object}
    */
    this.pkgdata = await fs.readJson(`${this.path}/package.json`);
    /**
    * Semver formatted version number of the local framework copy
    * @type {String}
    */
    this.version = this.pkgdata.version;
  }
  /**
  * Loads schemas from the local copy of the Adapt framework and registers them with the app
  * @return {Promise}
  */
  async loadSchemas() {
    /**
    * Names of all registered content schemas
    * @type {Array<String>}
    */
    this.contentSchemas = [];

    const [ authored, jsonschema ] = await this.app.waitForModule('authored', 'jsonschema');
    const schemas = await glob(`${this.path}/src/**/schema/*.schema.json`);

    await Promise.all(schemas.map(async s => {
      const { name } = await jsonschema.registerSchema(s);
      this.contentSchemas.push(name);
      jsonschema.extendSchema(name, authored.schemaName);
    }));
    jsonschema.extendSchema('adaptbuild', authored.schemaName);
    jsonschema.extendSchema('course', 'tags');

    if(this.app.dependencies['usergroups']) {
      const usergroups = await this.app.waitForModule('usergroups');
      jsonschema.extendSchema('course', usergroups.schemaExtensionName);
    }
  }
  async checkContentAccess(req, data) {
    const content = await this.app.waitForModule('content');
    let course;
    if(data._type === 'course') {
      course = data;
    } else {
      [course] = await content.find({ _id: data._courseId || (await content.find(data))._courseId });
    }
    if(!course) {
      return;
    }
    const shareWithUsers = course._shareWithUsers && course._shareWithUsers.map(id => id.toString()) || [];
    const userId = req.auth.user._id.toString();
    const inSharedGroup = _.intersectionWith(course.userGroups, req.auth.user.userGroups, (a, b) => a.toString() === b.toString()).length > 0;
    return course._isShared || shareWithUsers.includes(userId) || inSharedGroup;
  }
  /**
  * Initialises the module routing
  * @return {Promise}
  */
  async initRoutes() {
    const [auth, server] = await this.app.waitForModule('auth', 'server');
    /**
    * Router for handling all non-API calls
    * @type {Router}
    */
    this.rootRouter = server.root.createChildRouter('adapt');
    this.rootRouter.addRoute({
      route: '/preview/:id/*',
      handlers: { get: (req, res, next) => { // fail silently
        FWUtils.getHandler(req, res, e => e ? res.status(e.statusCode || 500).end() : next());
      } }
    });
    /**
    * Router for handling all API calls
    * @type {Router}
    */
    this.apiRouter = server.api.createChildRouter('adapt');
    this.apiRouter.addRoute(
      {
        route: '/preview/:id',
        handlers: { post: FWUtils.postHandler }
      },
      {
        route: '/publish/:id',
        handlers: { post: FWUtils.postHandler, get: FWUtils.getHandler }
      },
      {
        route: '/import',
        handlers: { post: [FWUtils.importHandler] }
      },
      {
        route: '/export/:id',
        handlers: { post: FWUtils.postHandler, get: FWUtils.getHandler }
      }
    );
    auth.permissions.secureRoute(`${this.apiRouter.path}/preview`, 'post', ['preview:adapt']);
    auth.permissions.secureRoute(`${this.apiRouter.path}/publish`, 'get', ['publish:adapt']);
    auth.permissions.secureRoute(`${this.apiRouter.path}/publish`, 'post', ['publish:adapt']);
    auth.permissions.secureRoute(`${this.apiRouter.path}/import`, 'post', ['import:adapt']);
    auth.permissions.secureRoute(`${this.apiRouter.path}/export`, 'get', ['export:adapt']);
    auth.permissions.secureRoute(`${this.apiRouter.path}/export`, 'post', ['export:adapt']);
  }
  /**
  * Returns the absolute path to the specified plugin type folder
  * @param {String} pluginType
  * @return {String}
  */
  getPluginPath(pluginType) {
    const map = {
      component: 'components',
      extension: 'extensions',
      menu: 'menu',
      theme: 'theme'
    };
    return `${this.path}/src/${map[pluginType]}/`;
  }
}

module.exports = AdaptFrameworkModule;
