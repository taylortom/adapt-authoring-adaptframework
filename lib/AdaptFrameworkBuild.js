import _ from 'lodash'
import AdaptCli from 'adapt-cli'
import { App, Hook } from 'adapt-authoring-core'
import { createWriteStream } from 'fs'
import fs from 'fs-extra'
import path from 'path'
import semver from 'semver'
import zipper from 'zipper'

/**
 * Encapsulates all behaviour needed to build a single Adapt course instance
 * @memberof adaptframework
 */
class AdaptFrameworkBuild {
  /**
   * Imports a course zip to the database
   * @param {AdaptFrameworkBuildOptions} options
   * @return {Promise} Resolves to this AdaptFrameworkBuild instance
   */
  static async run (options) {
    const instance = new AdaptFrameworkBuild(options)
    await instance.build()
    return instance
  }

  /**
   * Returns a timestring to be used for an adaptbuild expiry
   * @return {String}
   */
  static async getBuildExpiry () {
    const framework = await App.instance.waitForModule('adaptframework')
    return new Date(Date.now() + framework.getConfig('buildLifespan')).toISOString()
  }

  /**
   * Options to be passed to AdaptFrameworkBuild
   * @typedef {Object} AdaptFrameworkBuildOptions
   * @property {String} action The type of build to execute
   * @property {String} courseId The course  to build
   * @property {String} userId The user executing the build
   * @property {String} expiresAt When the build expires
   *
   * @constructor
   * @param {AdaptFrameworkBuildOptions} options
   */
  constructor ({ action, courseId, userId, expiresAt }) {
    /**
     * The MongoDB collection name
     * @type {String}
     */
    this.collectionName = 'adaptbuilds'
    /**
     * The build action being performed
     * @type {String}
     */
    this.action = action
    /**
     * Shorthand for checking if this build is a preview
     * @type {Boolean}
     */
    this.isPreview = action === 'preview'
    /**
     * Shorthand for checking if this build is a publish
     * @type {Boolean}
     */
    this.isPublish = action === 'publish'
    /**
     * Shorthand for checking if this build is an export
     * @type {Boolean}
     */
    this.isExport = action === 'export'
    /**
     * The _id of the course being build
     * @type {String}
     */
    this.courseId = courseId
    /**
     * All JSON data describing this course
     * @type {Object}
     */
    this.expiresAt = expiresAt
    /**
     * All JSON data describing this course
     * @type {Object}
     */
    this.courseData = {}
    /**
     * All metadata related to assets used in this course
     * @type {Object}
     */
    this.assetData = {}
    /**
     * Metadata describing this build attempt
     * @type {Object}
     */
    this.buildData = {}
    /**
     * A map of _ids for use with 'friendly' IDs
     * @type {Object}
     */
    this.idMap = {}
    /**
     * _id of the user initiating the course build
     * @type {String}
     */
    this.userId = userId
    /**
     * The build output directory
     * @type {String}
     */
    this.dir = ''
    /**
     * The course build directory
     * @type {String}
     */
    this.buildDir = ''
    /**
     * The course content directory
     * @type {String}
     */
    this.courseDir = ''
    /**
     * The final location of the build
     * @type {String}
     */
    this.location = ''
    /**
     * List of plugins used in this course
     * @type {Array<Object>}
     */
    this.enabledPlugins = []
    /**
     * List of plugins NOT used in this course
     * @type {Array<Object>}
     */
    this.disabledPlugins = []
    /**
     * Invoked prior to a course being built.
     * @type {Hook}
     */
    this.preBuildHook = new Hook({ mutable: true })
    /**
      * Invoked after a course has been built.
      * @type {Hook}
      */
    this.postBuildHook = new Hook({ mutable: true })
  }

  /**
   * Makes sure the directory exists
   * @param {string} dir
   */
  async ensureDir (dir) {
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }

  /**
   * Runs the Adapt framework build tools to generate a course build
   * @return {Promise} Resolves with the output directory
   */
  async build () {
    await this.removeOldBuilds()

    const framework = await App.instance.waitForModule('adaptframework')
    if (!this.expiresAt) {
      this.expiresAt = await AdaptFrameworkBuild.getBuildExpiry()
    }
    this.dir = path.resolve(framework.getConfig('buildDir'), new Date().getTime().toString())
    this.buildDir = path.join(this.dir, 'build')
    this.courseDir = path.join(this.dir, 'src', 'course')

    const cacheDir = path.join(this.buildDir, 'cache')

    await this.ensureDir(this.dir)
    await this.ensureDir(this.buildDir)
    await this.ensureDir(cacheDir)

    await this.loadCourseData()

    await Promise.all([
      this.copyAssets(),
      this.copySource()
    ])
    await this.preBuildHook.invoke(this)
    await framework.preBuildHook.invoke(this)

    await this.writeContentJson()

    if (!this.isExport) {
      try {
        await AdaptCli.buildCourse({
          cwd: this.dir,
          sourceMaps: !this.isPublish,
          outputDir: this.buildDir,
          cachePath: path.resolve(cacheDir, this.courseId),
          logger: { log: (...args) => App.logger.log('debug', 'adapt-cli', ...args) }
        })
      } catch (e) {
        throw App.instance.errors.FW_CLI_BUILD_FAILED
          .setData({ cmd: e.cmd, stderr: e.stderr })
      }
    }
    this.isPreview ? await this.createPreview() : await this.createZip()

    await this.postBuildHook.invoke(this)
    await framework.postBuildHook.invoke(this)

    this.buildData = await this.recordBuildAttempt()
  }

  /**
   * Collects and caches all the DB data for the course being built
   * @return {Promise}
   */
  async loadCourseData () {
    const content = await App.instance.waitForModule('content')
    const [course] = await content.find({ _id: this.courseId, _type: 'course' })
    if (!course) {
      throw App.instance.errors.NOT_FOUND.setData({ type: 'course', id: this.courseId })
    }
    const langDir = path.join(this.courseDir, 'en')
    this.courseData = {
      course: { dir: langDir, fileName: 'course.json', data: undefined },
      config: { dir: this.courseDir, fileName: 'config.json', data: undefined },
      contentObject: { dir: langDir, fileName: 'contentObjects.json', data: [] },
      article: { dir: langDir, fileName: 'articles.json', data: [] },
      block: { dir: langDir, fileName: 'blocks.json', data: [] },
      component: { dir: langDir, fileName: 'components.json', data: [] }
    }
    await this.loadAssetData()
    const contentItems = [course, ...await content.find({ _courseId: course._id })]
    this.createIdMap(contentItems)
    this.sortContentItems(contentItems)
    await this.cachePluginData()
    this.transformContentItems(contentItems)
  }

  /**
   * Processes and caches the course's assets
   * @return {Promise}
   */
  async loadAssetData () {
    const [assets, courseassets, mongodb, tags] = await App.instance.waitForModule('assets', 'courseassets', 'mongodb', 'tags')

    const caRecs = await courseassets.find({ courseId: this.courseId })
    const uniqueAssetIds = new Set(caRecs.map(c => mongodb.ObjectId.parse(c.assetId)))
    const usedAssets = await assets.find({ _id: { $in: [...uniqueAssetIds] } })

    const usedTagIds = new Set(usedAssets.reduce((m, a) => [...m, ...(a.tags ?? [])], []))
    const usedTags = await tags.find({ _id: { $in: [...usedTagIds] } })
    const tagTitleLookup = t => usedTags.find(u => u._id.toString() === t.toString()).title

    const idMap = {}
    const assetDocs = []
    const courseDir = this.courseData.course.dir

    await Promise.all(usedAssets.map(async a => {
      assetDocs.push({ ...a, tags: a?.tags?.map(tagTitleLookup) })
      if (!idMap[a._id]) idMap[a._id] = a.url ? a.url : path.join(courseDir, 'assets', a.path)
    }))
    this.assetData = { dir: courseDir, fileName: 'assets.json', idMap, data: assetDocs }
  }

  /**
   * Caches lists of which plugins are/aren't being used in this course
   * @return {Promise}
   */
  async cachePluginData () {
    const all = (await (await App.instance.waitForModule('contentplugin')).find({}))
      .reduce((m, p) => Object.assign(m, { [p.name]: p }), {})

    const _cachePluginDeps = (p, memo = {}) => {
      Object.entries(p.pluginDependencies ?? {}).forEach(([name, version]) => {
        const p = memo[name] ?? all[name]
        const e = !p
          ? App.instance.errors.FW_MISSING_PLUGIN_DEP.setData({ name })
          : !semver.satisfies(p.version, version) ? App.instance.errors.FW_INCOMPAT_PLUGIN_DEP.setData({ name, version }) : undefined
        if (e) {
          throw e.setData({ name, version })
        }
        if (!memo[name]) {
          _cachePluginDeps(p, memo)
          memo[name] = p
        }
      })
      return memo
    }
    const enabled = (this.courseData.config.data._enabledPlugins || [])
      .reduce((plugins, name) => {
        const p = all[name]
        return Object.assign(plugins, { [name]: p, ..._cachePluginDeps(p) })
      }, {})

    Object.entries(all).forEach(([name, p]) => (enabled[name] ? this.enabledPlugins : this.disabledPlugins).push(p))
  }

  /**
   * Stores a map of friendlyId values to ObjectId _ids
   */
  createIdMap (items) {
    items.forEach(i => {
      this.idMap[i._id] = i._friendlyId
    })
  }

  /**
   * Sorts the course data into the types needed for each Adapt JSON file. Works by memoising items into an object using the relative sort order as a key used for sorting.
   * @param {Array<Object>} items The list of content objects
   */
  sortContentItems (items) {
    const getSortOrderStr = co => (co._type === 'course' ? '1' : co._sortOrder.toString()).padStart(4, '0') // note we pad to allow 9999 children
    const coMap = items.reduce((m, item) => Object.assign(m, { [item._id]: item }), {}) // object mapping items to their _id for easy lookup
    const sorted = {}
    items.forEach(i => {
      const type = i._type === 'page' || i._type === 'menu' ? 'contentObject' : i._type
      if (type === 'course' || type === 'config') {
        this.courseData[type].data = i
        return // don't sort the course or config items
      }
      if (!sorted[type]) sorted[type] = {}
      // recursively calculate a sort order which is relative to the entire course for comparison
      let sortOrder = ''
      for (let item = i; item; sortOrder = getSortOrderStr(item) + sortOrder, item = coMap[item._parentId]);
      sorted[type][sortOrder.padEnd(64, '0')] = i // pad the final string for comparison purposes
    }) // finally populate this.courseData with the sorted items
    Object.entries(sorted).forEach(([type, data]) => {
      this.courseData[type].data = Object.keys(data).sort().map(key => data[key])
    })
  }

  /**
   * Transforms content items into a format recognised by the Adapt framework
   */
  transformContentItems (items) {
    items.forEach(i => {
      // slot any _friendlyIds into the _id field
      ['_courseId', '_parentId'].forEach(k => {
        i[k] = this.idMap[i[k]] || i[k]
      })
      if (i._friendlyId) {
        i._id = i._friendlyId
        delete i._friendlyId
      }
      // replace asset _ids with correct paths
      const idMapEntries = Object.entries(this.assetData.idMap)
      const itemString = idMapEntries.reduce((s, [_id, assetPath]) => {
        const relPath = assetPath.replace(this.courseDir, 'course').replaceAll(path.sep, '/')
        return s.replace(new RegExp(_id, 'g'), relPath)
      }, JSON.stringify(i))
      Object.assign(i, JSON.parse(itemString))
      // insert expected _component values
      if (i._component) {
        i._component = this.enabledPlugins.find(p => p.name === i._component).targetAttribute.slice(1)
      }
    })
    // move globals to a nested _extensions object as expected by the framework
    this.enabledPlugins.forEach(({ targetAttribute, type }) => {
      let key = `_${type}`
      if (type === 'component' || type === 'extension') key += 's'
      try {
        _.merge(this.courseData.course.data._globals, {
          [key]: { [targetAttribute]: this.courseData.course.data._globals[targetAttribute] }
        })
        delete this.courseData.course.data._globals[targetAttribute]
      } catch (e) {}
    })
  }

  /**
   * Copies the source code needed for this course
   * @return {Promise}
   */
  async copySource () {
    const { path: fwPath } = await App.instance.waitForModule('adaptframework')
    const blacklist = ['.git', '.DS_Store', 'thumbs.db', 'node_modules', 'course', ...this.disabledPlugins.map(p => p.name)]
    await fs.copy(fwPath, this.dir, { filter: f => !blacklist.includes(path.basename(f)) })
    if (!this.isExport) await fs.symlink(`${fwPath}/node_modules`, `${this.dir}/node_modules`, 'junction')
  }

  /**
   * Deals with copying all assets used in this course
   * @return {Promise}
   */
  async copyAssets () {
    const assets = await App.instance.waitForModule('assets')
    return Promise.all(this.assetData.data.map(async a => {
      if (a.url) {
        return
      }
      await this.ensureDir(path.dirname(this.assetData.idMap[a._id]))
      const inputStream = await assets.createFsWrapper(a).read(a)
      const outputStream = createWriteStream(this.assetData.idMap[a._id])
      inputStream.pipe(outputStream)
      return new Promise((resolve, reject) => {
        inputStream.on('end', () => resolve())
        outputStream.on('error', e => reject(e))
      })
    }))
  }

  /**
   * Outputs all course data to the required JSON files
   * @return {Promise}
   */
  async writeContentJson () {
    const data = Object.values(this.courseData)
    if (this.isExport && this.assetData.data.length) {
      this.assetData.data.map(d => {
        return {
          title: d.title,
          description: d.description,
          tags: d.tags
        }
      })
      data.push(this.assetData)
    }
    return Promise.all(data.map(async ({ dir, fileName, data }) => {
      await this.ensureDir(dir)
      return fs.writeJson(path.join(dir, fileName), data, { spaces: 2 })
    }))
  }

  /**
   * Makes sure the output folder is structured to allow the files to be served statically for previewing
   * @return {Promise}
   */
  async createPreview () {
    const tempName = `${this.dir}_temp`
    await fs.move(path.join(this.dir, 'build'), tempName)
    await fs.remove(this.dir)
    await fs.move(tempName, this.dir)
    this.location = this.dir
  }

  /**
   * Creates a zip file containing all files relevant to the type of build being performed
   * @return {Promise}
   */
  async createZip () {
    const zipPath = path.join(this.dir, this.isPublish ? 'build' : '')
    const outputPath = `${this.dir}.zip`
    await zipper.zip(zipPath, outputPath, { removeSource: true })
    await fs.remove(this.dir)
    this.location = outputPath
  }

  /**
   * Stored metadata about a build attempt in the DB
   * @return {Promise} Resolves with the DB document
   */
  async recordBuildAttempt () {
    const [framework, jsonschema, mongodb] = await App.instance.waitForModule('adaptframework', 'jsonschema', 'mongodb')
    const schema = await jsonschema.getSchema('adaptbuild')
    const validatedData = await schema.validate({
      action: this.action,
      courseId: this.courseId,
      location: this.location,
      expiresAt: this.expiresAt,
      createdBy: this.userId,
      versions: this.enabledPlugins.reduce((m, p) => {
        return { ...m, [p.name]: p.version }
      }, { adapt_framework: framework.version })
    })
    return mongodb.insert(this.collectionName, validatedData)
  }

  /**
   * Removes all previous builds of this.action type
   * @return {Promise}
   */
  async removeOldBuilds () {
    const mongodb = await App.instance.waitForModule('mongodb')
    const query = { action: this.action, createdBy: this.userId }
    const oldBuilds = await mongodb.find(this.collectionName, query)
    await Promise.all(oldBuilds.map(b => fs.remove(b.location)))
    return mongodb.deleteMany(this.collectionName, query)
  }
}

export default AdaptFrameworkBuild
