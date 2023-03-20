async function ComponentTransform (data) {
  if (data._type !== 'component') {
    return
  }
  if (data._playerOptions === '') {
    delete data._playerOptions
  }
}

export default ComponentTransform
