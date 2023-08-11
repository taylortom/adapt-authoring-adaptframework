const responseDataMeta = {
  200: {
    description: 'The Adapt build data',
    content: {
      'application/json': {
        schema: { $ref: '#components/schemas/adaptbuild' }
      }
    }
  }
}

const responseZipMeta = {
  200: {
    description: 'Course build zip file',
    content: { 'application/zip': {} }
  }
}

const statusReportItemSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      data: { type: 'string' }
    }
  }
}

const params = type => [{ name: 'id', in: 'path', description: `${type} _id`, required: true }]

export default {
  preview: {
    post: {
      summary: 'Build a preview of an Adapt course',
      parameters: params('Course'),
      responses: responseDataMeta
    }
  },
  publish: {
    post: {
      summary: 'Create a publish zip of an Adapt course',
      parameters: params('Course'),
      responses: responseDataMeta
    },
    get: {
      summary: 'Retrieve an Adapt course publish zip',
      parameters: params('Build'),
      responses: responseZipMeta
    }
  },
  import: {
    post: {
      summary: 'Import an Adapt course',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: {
                isDryRun: { type: 'Boolean', default: false },
                importContent: { type: 'Boolean', default: true },
                importPlugins: { type: 'Boolean', default: true },
                updatePlugins: { type: 'Boolean', default: false }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '',
          content: {
            'application/json': {
              schema: {
                properties: {
                  title: { type: 'string' },
                  courseId: { type: 'string' },
                  versions: { type: 'object' },
                  content: {
                    type: 'object',
                    properties: {
                      course: { type: 'number' },
                      config: { type: 'number' },
                      menu: { type: 'number' },
                      page: { type: 'number' },
                      article: { type: 'number' },
                      block: { type: 'number' },
                      component: { type: 'number' }
                    }
                  },
                  statusReport: {
                    type: 'object',
                    properties: {
                      error: statusReportItemSchema,
                      warn: statusReportItemSchema,
                      info: statusReportItemSchema
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  export: {
    post: {
      summary: 'Create an export zip of an Adapt course',
      parameters: params('Course'),
      responses: responseDataMeta
    },
    get: {
      summary: 'Retrieve an Adapt course export zip',
      parameters: params('Build'),
      responses: responseZipMeta
    }
  },
  update: {
    post: {
      summary: 'Updates the installed framework',
      responses: {
        200: {
          description: 'Describes the upgraded elements',
          content: {
            'application/json': {
              schema: {
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }
}
