async function RemoveUndef (data) {
  Object.entries(data).forEach(([k, v]) => {
    if (v === null) {
      delete data[k]
      return
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      RemoveUndef(v)
    }
  })
}

export default RemoveUndef
