async function ComponentTransform (data, importer) {
  if (data._type !== 'component') {
    return
  }
  data._component = importer.componentNameMap[data._component]

  if (data._playerOptions === '') {
    delete data._playerOptions
  }
}

export default ComponentTransform
