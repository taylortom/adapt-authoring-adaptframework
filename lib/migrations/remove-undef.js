async function RemoveUndef(data) {
  Object.entries(data).forEach((k, v) => {
    if(typeof v === 'object' && !Array.isArray(v)) {
      RemoveUndef(v);
      return;
    }
    if(v === undefined || v === null) {
      delete data[k];
    }
  });
}

export default RemoveUndef;