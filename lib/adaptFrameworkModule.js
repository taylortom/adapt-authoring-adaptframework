const { App, AbstractModule, Utils } = require('adapt-authoring-core');
const glob = require('glob');
const util = require('util');
/** @ignore */ const globPromise = util.promisify(glob);

/**
*
* @extends {AbstractModule}
*/
class AdataFrameworkModule extends AbstractModule {
  /** @override */
  constructor(...args) {
    super(...args);
    this.init();
  }
  async init() {
    await this.loadSchemas();
    await this.initRoutes();
    this.setReady();
  }
  async loadSchemas() {
    const jsonschema = this.app.waitForModule('jsonschema');
    const schemas = await globPromise('node_modules/adapt_framework/src/core/schema/*.model.schema');
    Promise.all(schemas.map(s => jsonschema.registerSchema(s)));
  }
  async initRoutes() {
    const server = this.app.waitForModule('server');
    this.router = server.api.createChildRouter('adapt');
  }
}

module.exports = AbstractApiModule;
