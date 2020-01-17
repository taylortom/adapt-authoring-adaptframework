const { AbstractModule } = require('adapt-authoring-core');
const FWUtils = require('./adaptFrameworkUtils');
const glob = require('glob');
const util = require('util');
/** @ignore */ const globPromise = util.promisify(glob);
/**
*
* @extends {AbstractModule}
*/
class AdaptFrameworkModule extends AbstractModule {
  /** @override */
  constructor(...args) {
    /**
    TODO:
    - Convert schemas
    - Update framework to export schemas
    - Fix issue with framework adapt.json
    - Refactor module to extend AbstractApiModule
    */
    super(...args);
    this.init();
  }
  async init() {
    // await this.loadSchemas();
    await this.initRoutes();
    this.setReady();
  }
  async loadSchemas() {
    const jsonschema = await this.app.waitForModule('jsonschema');
    const schemas = await globPromise('node_modules/adapt_framework/src/core/schema/*.model.schema');
    return Promise.all(schemas.map(s => jsonschema.registerSchema(s)));
  }
  async initRoutes() {
    const server = await this.app.waitForModule('server');
    this.router = server.api.createChildRouter('adapt');
    this.router.addRoute(...[
      {
        route: '/:file',
        handlers: { get: this.servePreview }
      },
      {
        route: '/preview/:courseid',
        handlers: { get: this.handlePreview }
      },
      {
        route: '/publish',
        handlers: { post: this.handlePublish }
      },
      {
        route: '/export',
        handlers: { post: this.handleExport }
      }
    ]);
  }
  handlePreview(req, res, next) {
    this.log('info', `running preview for course '${req.params.courseid}'`);
    try {
      const buildData = await FWUtils.buildCourse(req.params.courseid);
      const mdb = await this.app.waitForModule('mongodb');
      const previewData = await mdb.create({
        type: 'preview',
        courseId: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        dir: buildData.dir
      });
      res.json(previewData);
    } catch(e) {
      next(e);
    }
  }
  handlePublish(req, res, next) {
    res.send('publish');
  }
  handleExport(req, res, next) {
    res.send('export');
  }
}

module.exports = AdaptFrameworkModule;
