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
  async init() {
    await this.initFramework();
    await this.loadSchemas();
    await this.initRoutes();
    this.setReady();
  }
  async initFramework() {
    this.framework_dir = path.join(this.app.getConfig('temp_dir'), 'adapt_framework');
    try {
      this.log('debug', 'existing local adapt_framework found');
      await fs.stat(this.framework_dir);
    } catch(e) {
      this.log('debug', 'no local adapt_framework found, initialising');
      await FWUtils.createLocalFramework(this.framework_dir);
      this.log('debug', 'local adapt_framework initialised');
    }
  }
  async loadSchemas() {
    return;
    const jsonschema = await this.app.waitForModule('jsonschema');
    const schemas = await util.promisify(glob)('node_modules/adapt_framework/src/core/schema/*.model.schema');
    return Promise.all(schemas.map(s => jsonschema.registerSchema(s)));
  }
  async initRoutes() {
    const server = await this.app.waitForModule('server');
    // Root endpoints
    this.rootRouter = server.root.createChildRouter('adapt');
    this.rootRouter.addRoute({
      route: '/preview/:id/*',
      handlers: { get: FWUtils.getHandler.bind(this) }
    });
    // API endpoints
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
}

module.exports = AdaptFrameworkModule;
