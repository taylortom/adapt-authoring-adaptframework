async function ConfigTransform (data) {
  if (data._type !== 'course' || data._globals._extensions?._pageLevelProgress?._navOrder === undefined) {
    return
  }
  data._globals._extensions._pageLevelProgress._navOrder = Number(data._globals._extensions._pageLevelProgress._navOrder)
}

export default ConfigTransform
