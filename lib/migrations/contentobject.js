async function ContentObjectTransform(data) {
  if(data._type !== 'page' && data._type !== 'menu') {
    return data;
  }
  removeBgImage(data._vanilla);
  removeBgStyles(data._vanilla);
  removeBgImage(data._vanilla._pageHeader);
  removeBgStyles(data._vanilla._pageHeader);
  removeMinHeights(data._vanilla._pageHeader);

  return data;
}

function removeBgImage({ _backgroundImage }) {
  if(_backgroundImage._large === "") delete _backgroundImage._large;
  if(_backgroundImage._medium === "") delete _backgroundImage._medium;
  if(_backgroundImage._small === "") delete _backgroundImage._small;
}

function removeBgStyles({ _backgroundStyles }) {
  if(_backgroundStyles._backgroundRepeat === null) delete _backgroundStyles._backgroundRepeat;
  if(_backgroundStyles._backgroundSize === null) delete _backgroundStyles._backgroundSize;
  if(_backgroundStyles._backgroundPisition === null) delete _backgroundStyles._backgroundPisition;
}

function removeMinHeights({ _minimumHeights }) {
  if(_minimumHeights._large === null) delete _minimumHeights._large;
  if(_minimumHeights._medium === null) delete _minimumHeights._medium;
  if(_minimumHeights._small === null) delete _minimumHeights._small;
}

export default ContentObjectTransform;