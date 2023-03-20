async function ConfigTransform (data) {
  if (data._type !== 'config' || !data._accessibility._ariaLevels) {
    return
  }
  ['_menu', '_menuItem', '_page', '_article', '_block', '_component', '_componentItem', '_notify'].forEach(k => {
    const val = data._accessibility._ariaLevels[k]
    if (val) data._accessibility._ariaLevels[k] = String(val)
  })
}

export default ConfigTransform
