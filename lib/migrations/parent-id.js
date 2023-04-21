async function ParentIdTransform (data, importer) {
  if (data._parentId) {
    data._parentId = importer.idMap[data._parentId]
  }
}

export default ParentIdTransform
