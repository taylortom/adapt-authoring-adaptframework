const { AbstractModule } = require('adapt-authoring-core');
const FWUtils = require('./adaptFrameworkUtils');
const fs = require('fs-extra');
const glob = require('glob');
const path = require('path');
const util = require('util');
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
    this.frameworkPath = path.join(this.app.getConfig('temp_dir'), 'adapt_framework');
    try {
      await fs.stat(this.frameworkPath);
      this.log('debug', 'existing local adapt_framework found');
    } catch(e) {
      this.log('debug', 'no local adapt_framework found, initialising');
      await FWUtils.createLocalFramework(this.frameworkPath);
      this.frameworkPkg = await fs.readJson(`${this.frameworkPath}/package.json`);
      this.log('debug', 'local adapt_framework initialised');
    }
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

    const jsonschema = await this.app.waitForModule('jsonschema');
    const schemas = await util.promisify(glob)('node_modules/adapt_framework/src/core/schema/*.schema.json');

    await Promise.all(schemas.map(async s => {
      const data = await jsonschema.registerSchema(s);
      this.contentSchemas.push(data.name);
    }));
    jsonschema.extendSchema('adaptbuild', 'authored');
    jsonschema.extendSchema('course', 'tags');
  }
  /**
  * Initialises the module routing
  * @return {Promise}
  */
  async initRoutes() {
    const server = await this.app.waitForModule('server');
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
    return `${this.frameworkPath}/src/${map[pluginType]}/`;
  }
}

module.exports = AdaptFrameworkModule;
