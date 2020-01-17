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
    this.apiRouter = server.api.createChildRouter('adapt');
    this.apiRouter.addRoute(
      {
        route: '/preview/:courseid',
        handlers: { post: this.createCoursePreview.bind(this) }
      },
      {
        route: '/publish/:courseid',
        handlers: {
          post: this.createCoursePublish.bind(this),
          get: this.serveCoursePublish.bind(this)
        }
      },
      {
        route: '/export/:courseid',
        handlers: {
          post: this.createCourseExport.bind(this),
          get: this.serveCourseExport.bind(this)
        }
      }
    );
    this.rootRouter = server.root.createChildRouter('adapt');
    this.rootRouter.addRoute({
      route: '/preview/:id/*',
      handlers: { get: this.serveCoursePreview }
    });
  }
  async createCoursePreview(req, res, next) {
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
  async serveCoursePreview(req, res, next) {
    res.send(`servePreview with _id ${req.params.id}`);
  }
  async createCoursePublish(req, res, next) {
    res.send(`create publish for course ${req.params.courseid}`);
  }
  async serveCoursePublish(req, res, next) {
    res.send(`serve publish for course ${req.params.courseid}`);
  }
  async createCourseExport(req, res, next) {
    res.send(`create export for course ${req.params.courseid}`);
  }
  async serveCourseExport(req, res, next) {
    res.send(`serve export for course ${req.params.courseid}`);
  }
}

module.exports = AdaptFrameworkModule;
