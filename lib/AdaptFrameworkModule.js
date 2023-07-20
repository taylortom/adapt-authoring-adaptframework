import { AbstractModule, Hook } from 'adapt-authoring-core'
import AdaptCli from 'adapt-cli'
import AdaptFrameworkBuild from './AdaptFrameworkBuild.js'
import AdaptFrameworkImport from './AdaptFrameworkImport.js'
import ApiDefs from './apidefs.js'
import fs from 'fs-extra'
import FWUtils from './AdaptFrameworkUtils.js'
import path from 'path'
import semver from 'semver'
import { unzip } from 'zipper'
/**
 * Module to handle the interface with the Adapt framework
 * @memberof adaptframework
 * @extends {AbstractModule}
 */
class AdaptFrameworkModule extends AbstractModule {
  /** @override */
  async init () {
    /**
     * Location of the local Adapt framework files
     * @type {String}
     */
    this.path = this.getConfig('frameworkDir')
    /**
     * Invoked prior to a course being built. The AdaptFrameworkBuild instance is passed to any observers.
     * @type {Hook}
     */
    this.preBuildHook = new Hook({ mutable: true })
    /**
     * Invoked after a course has been built. The AdaptFrameworkBuild instance is passed to any observers.
     * @type {Hook}
     */
    this.postBuildHook = new Hook({ mutable: true })

    await this.installFramework()

    if (this.app.args['update-framework'] === true) {
      await this.updateFramework()
    }
    await Promise.all([this.loadSchemas(), this.initRoutes()])

    const content = await this.app.waitForModule('content')
    content.accessCheckHook.tap(this.checkContentAccess.bind(this))

    this.logStatus()
  }

  /**
   * Semver formatted version number of the local framework copy
   * @type {String}
   */
  get version () {
    return AdaptCli.getCurrentFrameworkVersion()
  }

  /**
   * Installs a local copy of the Adapt framework
   * @return {Promise}
   */
  async installFramework () {
    try {
      const modsPath = path.resolve(this.path, '..', 'node_modules')
      try {
        await fs.stat(modsPath)
        await fs.readJson(path.resolve(this.path, 'package.json'))
        return
      } catch (e) {
        // if src and node_modules are missing, install required
      }
      await AdaptCli.installFramework({
        repository: this.getConfig('frameworkRepository'),
        cwd: this.path
      })
      // move node_modules into place
      try {
        await fs.remove(modsPath)
      } catch (e) {}
      // move node_modules so it can be shared with all builds
      await fs.move(path.join(this.path, 'node_modules'), modsPath)
    } catch (e) {
      this.log('error', `failed to install framework, ${e.message}`)
      throw this.app.errors.FW_INSTALL_FAILED
    }
  }

  /**
   * Updates the local copy of the Adapt framework
   * @return {Promise}
   */
  async getLatestVersion () {
    try {
      return semver.clean(await AdaptCli.getLatestFrameworkVersion({ repository: this.getConfig('frameworkRepository') }))
    } catch (e) {
      this.log('error', `failed to retrieve framework update data, ${e.message}`)
      throw e
    }
  }

  /**
   * Retrieves the locally installed plugins
   * @return {Promise}
   */
  async getInstalledPlugins () {
    return AdaptCli.getInstalledDependencies()
  }

  /**
   * Updates the local copy of the Adapt framework
   * @return {Promise}
   */
  async updateFramework () {
    try {
      await AdaptCli.updateFramework({
        repository: this.getConfig('frameworkRepository'),
        cwd: this.path
      })
    } catch (e) {
      this.log('error', `failed to update framework, ${e.message}`)
      throw this.app.errors.FW_UPDATE_FAILED
    }
  }

  /**
   * Logs relevant framework status messages
   */
  async logStatus () {
    const current = this.version
    const latest = await AdaptCli.getLatestFrameworkVersion({ repository: this.getConfig('frameworkRepository') })

    this.log('info', `local adapt_framework v${current} installed`)
    if (semver.lt(current, latest)) {
      this.log('info', `a newer version of the adapt_framework is available (${latest}), pass the --update-framework flag to update`)
    }
  }

  /**
   * Loads schemas from the local copy of the Adapt framework and registers them with the app
   * @return {Promise}
   */
  async loadSchemas () {
    const jsonschema = await this.app.waitForModule('jsonschema')
    const schemas = (await AdaptCli.getSchemaPaths({ cwd: this.path })).filter(s => s.includes('/core/'))
    await Promise.all(schemas.map(s => jsonschema.registerSchema(s)))
  }

  /**
   * Checks whether the request user should be given access to the content they're requesting
   * @param {external:ExpressRequest} req
   * @param {Object} data
   * @return {Promise} Resolves with boolean
   */
  async checkContentAccess (req, data) {
    const content = await this.app.waitForModule('content')
    let course
    if (data._type === 'course') {
      course = data
    } else {
      [course] = await content.find({ _id: data._courseId || (await content.find(data))._courseId })
    }
    if (!course) {
      return
    }
    const shareWithUsers = course?._shareWithUsers.map(id => id.toString()) ?? []
    const userId = req.auth.user._id.toString()
    return course._isShared || shareWithUsers.includes(userId)
  }

  /**
   * Initialises the module routing
   * @return {Promise}
   */
  async initRoutes () {
    const [auth, server] = await this.app.waitForModule('auth', 'server')
    /**
     * Router for handling all non-API calls
     * @type {Router}
     */
    this.rootRouter = server.root.createChildRouter('adapt')
    this.rootRouter.addRoute({
      route: '/preview/:id/*',
      handlers: {
        get: (req, res, next) => { // fail silently
          FWUtils.getHandler(req, res, e => e ? res.status(e.statusCode || 500).end() : next())
        }
      }
    })
    /**
     * Router for handling all API calls
     * @type {Router}
     */
    this.apiRouter = server.api.createChildRouter('adapt')
    this.apiRouter.addRoute(
      {
        route: '/preview/:id',
        handlers: { post: FWUtils.postHandler },
        meta: ApiDefs.preview
      },
      {
        route: '/publish/:id',
        handlers: { post: FWUtils.postHandler, get: FWUtils.getHandler },
        meta: ApiDefs.publish
      },
      {
        route: '/import',
        handlers: { post: [FWUtils.importHandler] },
        meta: ApiDefs.import
      },
      {
        route: '/export/:id',
        handlers: { post: FWUtils.postHandler, get: FWUtils.getHandler },
        meta: ApiDefs.export
      }
    )
    auth.secureRoute(`${this.apiRouter.path}/preview/:id`, 'post', ['preview:adapt'])
    auth.secureRoute(`${this.apiRouter.path}/publish/:id`, 'get', ['publish:adapt'])
    auth.secureRoute(`${this.apiRouter.path}/publish/:id`, 'post', ['publish:adapt'])
    auth.secureRoute(`${this.apiRouter.path}/import`, 'post', ['import:adapt'])
    auth.secureRoute(`${this.apiRouter.path}/export/:id`, 'get', ['export:adapt'])
    auth.secureRoute(`${this.apiRouter.path}/export/:id`, 'post', ['export:adapt'])
    auth.secureRoute(`${this.apiRouter.path}/update`, 'post', ['update:adapt'])

    if (this.getConfig('enableUpdateApi')) {
      this.apiRouter.addRoute({
        route: '/update',
        handlers: { post: FWUtils.postUpdateHandler, get: FWUtils.getUpdateHandler },
        meta: ApiDefs.update
      })
      auth.secureRoute(`${this.apiRouter.path}/update`, 'get', ['update:adapt'])
    }
  }

  /**
   * Builds a single Adapt framework course
   * @param {AdaptFrameworkBuildOptions} options
   * @return {AdaptFrameworkBuild}
   */
  async buildCourse (options) {
    return AdaptFrameworkBuild.run(options)
  }

  /**
   * Imports a single Adapt framework course
   * @param {String} importPath Path to the course import
   * @param {String} userId _id of the new owner of the imported course
   * @return {AdaptFrameworkImportSummary}
   */
  async importCourse (importPath, userId) {
    let unzipPath = importPath
    if (importPath.endsWith('.zip')) {
      unzipPath = `${importPath}_unzip`
      await unzip(importPath, unzipPath, { removeSource: true })
    }
    const importer = await AdaptFrameworkImport.run({ unzipPath, userId })
    return await FWUtils.getImportSummary(importer)
  }
}

export default AdaptFrameworkModule
