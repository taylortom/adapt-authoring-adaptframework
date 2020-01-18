const { AbstractModule, Utils } = require('adapt-authoring-core');
const FWUtils = require('./adaptFrameworkUtils');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const glob = require('glob');
const path = require('path');
const util = require('util');
/** @ignore */ const globPromise = util.promisify(glob);
/**
TODO:
- Convert schemas
- Update framework to export schemas
- Fix issue with framework adapt.json
- Refactor module to extend AbstractApiModule
*/
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
    // await this.loadSchemas();
    await this.initFramework();
    await this.initRoutes();
    this.setReady();
  }
  async loadSchemas() {
    const jsonschema = await this.app.waitForModule('jsonschema');
    const schemas = await globPromise('node_modules/adapt_framework/src/core/schema/*.model.schema');
    return Promise.all(schemas.map(s => jsonschema.registerSchema(s)));
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
  async initRoutes() {
    const server = await this.app.waitForModule('server');
    this.apiRouter = server.api.createChildRouter('adapt');
    this.rootRouter = server.root.createChildRouter('adapt');
    this.rootRouter.addRoute({
      route: '/preview/:id/*',
      handlers: { get: this.serveCoursePreview.bind(this) }
    });
    this.apiRouter.addRoute({
      route: '/preview/:id',
      handlers: { post: this.postHandler.bind(this) }
    }, {
      route: '/publish|export/:id',
      handlers: {
        post: this.postHandler.bind(this),
        get: this.getHandler.bind(this)
      }
    });
  }
  async postHandler(req, res, next) {
    const action = this.inferAction(req);
    console.log('postHandler', action);
    this.log('info', `running ${action} for course '${req.params.id}'`);
    try {
      const data = await FWUtils.performCourseAction(req.params.id, action);
      this.log('info', `finished ${action} for course '${req.params.id}'`);
      res.json({ [`${action}_url`]: `${this.rootRouter.url}/${action}/${data._id}/` });
    } catch(e) {
      next(e);
    }
  }
  async getHandler(req, res, next) {
    const action = this.inferAction(req);
    const id = req.params.id;
    let filepath;
    console.log('getHandler', action);
    try {
      filepath = (await FWUtils.retrieveBuildData(id)).location;
    } catch(e) {
      return next(e);
    }
    if(action === 'preview') {
      filepath = path.join(filepath, req.path.slice(req.path.indexOf(id)+id.length+1) || 'index.html');
    }
    res.sendFile(filepath);
  }
  async serveCoursePreview(req, res, next) {
    const id = req.params.id;
    const filepath = req.path.slice(req.path.indexOf(id)+id.length+1) || 'index.html';
    try {
      const previewData = await FWUtils.retrieveBuildData(id);
      res.sendFile(path.join(previewData.location, filepath));
    } catch(e) {
      next(e);
    }
  }
  inferAction(req) {
    return req.url.slice(1, req.url.indexOf('/', 1));
  }
}

module.exports = AdaptFrameworkModule;
