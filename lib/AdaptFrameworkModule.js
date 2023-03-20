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
     * Cached adapt.json data for the local framework copy
     * @type {Object}
     */
    this.plugindata = undefined
    /**
     * Cached package.json data for the local framework copy
     * @type {Object}
     */
    this.pkgdata = undefined
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

    /** @ignore */ this.pkgdata = await fs.readJson(`${this.path}/package.json`)
    /** @ignore */ this.plugindata = await fs.readJson(`${this.path}/adapt.json`)

    await Promise.all([this.loadSchemas(), this.initRoutes()])

    const content = await this.app.waitForModule('content')
    content.accessCheckHook.tap(this.checkContentAccess.bind(this))
  }

  /**
   * Semver formatted version number of the local framework copy
   * @type {String}
   */
  get version () {
    return this.pkgdata.version
  }

  /**
   * Installs a local copy of the Adapt framework
   * @return {Promise}
   */
  async installFramework () {
    try {
      let latest
      try {
        latest = await AdaptCli.getLatestFrameworkVersion({ repository: this.getConfig('frameworkRepository') })
      } catch (e) {
        const isConnError = e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN'
        if (isConnError) this.log('error', 'no network connection')
        else throw e
      }
      let installFramework = false
      let pkg
      try {
        pkg = await fs.readJson(path.resolve(this.path, 'package.json'))
        if (!latest) latest = pkg.version
      } catch (e) {
        this.log('info', `no local adapt_framework found, installing ${latest}`)
        installFramework = true
      }
      if (pkg) {
        const shouldUpdate = this.app.args['update-framework']
        if (shouldUpdate) {
          installFramework = true
        } else { // prints logs and exit
          this.log('info', `local adapt_framework v${pkg.version} installed`)
          if (semver.lt(pkg.version, latest)) {
            this.log('info', `a newer version of the adapt_framework is available (${latest}), pass the --update-framework flag to update`)
          }
          return
        }
      }
      const modsPath = path.resolve(this.path, '..', 'node_modules')
      try {
        await fs.stat(modsPath)
      } catch (e) { // if node_modules is gone we need a full reinstall
        installFramework = true
      }
      console.log(`${this.path}/adapt.json`)
      if (installFramework) {
        try { // remove any existing framework
          await Promise.allSettled([
            fs.remove(this.path),
            fs.remove(modsPath)
          ])
        } catch (e) {}
        await AdaptCli.installFramework({
          version: latest,
          repository: this.getConfig('frameworkRepository'),
          cwd: this.path
        })
        // move node_modules so it can be shared with all builds
        await fs.move(path.join(this.path, 'node_modules'), modsPath)
        this.log('debug', 'FRAMEWORK_INSTALL', latest)
      }
    } catch (e) {
      this.log('error', `failed to install framework, ${e.message}`)
      throw this.app.errors.FW_INSTALL_FAILED
    }
  }

  async writeAdaptJson () {
    const adaptJsonPath = `${this.path}/adapt.json`
    const adaptJson = JSON.parse((await fs.readFile(adaptJsonPath)).toString())
    await fs.writeFile(JSON.stringify(adaptJson, null, 2), adaptJsonPath)
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
  }

  /**
   * Returns the absolute path to the specified plugin type folder
   * @param {String} pluginType
   * @return {String}
   */
  getPluginPath (pluginType) {
    const map = {
      component: 'components',
      extension: 'extensions',
      menu: 'menu',
      theme: 'theme'
    }
    return `${this.path}/src/${map[pluginType]}`
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
