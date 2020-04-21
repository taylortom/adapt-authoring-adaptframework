const { AbstractModule } = require('adapt-authoring-core');
const FWUtils = require('./adaptFrameworkUtils');
const fs = require('fs-extra');
const glob = require('util').promisify(require('glob'));
const path = require('path');
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
    this.path = path.join(this.app.getConfig('temp_dir'), 'adapt_framework');
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
    const schemas = await glob(`${this.path}/src/core/schema/*.schema.json`);

    await Promise.all(schemas.map(async s => {
      const { name } = await jsonschema.registerSchema(s);
      this.contentSchemas.push(name);
      jsonschema.extendSchema(name, authored.schemaName);
    }));
    jsonschema.extendSchema('adaptbuild', authored.schemaName);
    jsonschema.extendSchema('course', 'tags');
  }
  /**
  * Initialises the module routing
  * @return {Promise}
  */
  async initRoutes() {
    const [middleware, server] = await this.app.waitForModule('middleware', 'server');
    /**
    * Router for handling all non-API calls
    * @type {Router}
    */
    this.rootRouter = server.root.createChildRouter('adapt');
    this.rootRouter.addRoute({
      route: '/preview/:id/*',
      handlers: { get: FWUtils.getHandler.bind(this) }
    });
    /**
    * Router for handling all API calls
    * @type {Router}
    */
    this.apiRouter = server.api.createChildRouter('adapt');
    this.apiRouter.addRoute(
      {
        route: '/preview/:id',
        handlers: { post: FWUtils.postHandler.bind(this) }
      },
      {
        route: '/publish/:id',
        handlers: { post: FWUtils.postHandler.bind(this), get: FWUtils.getHandler.bind(this) }
      },
      {
        route: '/import',
        handlers: { post: [middleware.fileUploadParser('application/zip'), FWUtils.importHandler.bind(this)] }
      },
      {
        route: '/export/:id',
        handlers: { post: FWUtils.postHandler.bind(this), get: FWUtils.getHandler.bind(this) }
      }
    );
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
