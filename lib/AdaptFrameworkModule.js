const _ = require('lodash');
const fs = require('fs-extra');
const glob = require('util').promisify(require('glob'));
const path = require('path');

const { AbstractModule, Hook } = require('adapt-authoring-core');

const FWUtils = require('./AdaptFrameworkUtils');
const AdaptFrameworkBuild = require('./AdaptFrameworkBuild');
/**
 * Module to handle the interface with the Adapt framework
 * @extends {AbstractModule}
 */
class AdaptFrameworkModule extends AbstractModule {
  /** @override */
  async init() {
    /**
     * Location of the local Adapt framework files
     * @type {String}
     */
    this.path = path.resolve(this.app.rootDir, this.getConfig('frameworkDir'));
    /**
     * Cached package.json data for the local framework copy
     * @type {Object}
     */
    this.pkgdata;
    /**
     * Invoked prior to a course being built. The AdaptFrameworkBuild instance is passed to any observers.
     * @type {Hook}
     */
    this.preBuildHook = new Hook({ type: Hook.Types.Series, mutable: true });
    /**
     * Invoked after a course has been built. The AdaptFrameworkBuild instance is passed to any observers.
     * @type {Hook}
     */
    this.postBuildHook = new Hook({ type: Hook.Types.Series, mutable: true });

    await this.installFramework();

    /** @ignore */ this.pkgdata = await fs.readJson(`${this.path}/package.json`);

    await Promise.all([this.loadSchemas(), this.initRoutes()]);

    const content = await this.app.waitForModule('content');
    content.accessCheckHook.tap(this.checkContentAccess.bind(this));
  }
  /**
   * Semver formatted version number of the local framework copy
   * @type {String}
   */
  get version() {
    return this.pkgdata.version;
  }
  /**
   * Installs a local copy of the Adapt framework
   * @return {Promise}
   */
  async installFramework() {
    try {
      const { version: installed } = require(`${this.path}/package.json`);
      const { version: latest } = require(`${Utils.getModuleDir('adapt_framework')}/package.json`);
      if(installed === latest) {
        return this.log('debug', 'valid local adapt_framework found, skipping install');
      }
      this.log('debug', `local adapt_framework (${installed}) doesn't match required version (${latest}), updating`);
      await fs.remove(this.path);
    } catch(e) {
      this.log('debug', 'no local adapt_framework found, installing');
      await FWUtils.createLocalFramework(this.getConfig('frameworkRepository'), this.path);
      this.log('debug', 'local adapt_framework installed');
    }
  }
  /**
   * Loads schemas from the local copy of the Adapt framework and registers them with the app
   * @return {Promise}
   */
  async loadSchemas() {
    const [authored, jsonschema] = await this.app.waitForModule('authored', 'jsonschema');
    const schemas = await glob(`${this.path}/src/**/schema/*.schema.json`);
    await Promise.all(schemas.map(s => jsonschema.registerSchema(s)));

    jsonschema.extendSchema('adaptbuild', authored.schemaName);
  }
  /**
   * Checks whether the request user should be given access to the content they're requesting
   * @param {ClientRequest} req
   * @param {Object} data
   * @return {Promise} Resolves with boolean
   */
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
    auth.secureRoute(`${this.apiRouter.path}/preview/:id`, 'post', ['preview:adapt']);
    auth.secureRoute(`${this.apiRouter.path}/publish/:id`, 'get', ['publish:adapt']);
    auth.secureRoute(`${this.apiRouter.path}/publish/:id`, 'post', ['publish:adapt']);
    auth.secureRoute(`${this.apiRouter.path}/import`, 'post', ['import:adapt']);
    auth.secureRoute(`${this.apiRouter.path}/export/:id`, 'get', ['export:adapt']);
    auth.secureRoute(`${this.apiRouter.path}/export/:id`, 'post', ['export:adapt']);
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
    return `${this.path}/src/${map[pluginType]}`;
  }
  /**
   * Builds a single Adapt framework course
   * @param {AdaptFrameworkBuildOptions} options
   * @return {AdaptFrameworkBuild}
   */
  async buildCourse(options) {
    return AdaptFrameworkBuild.run(options);
  }
}

module.exports = AdaptFrameworkModule;
