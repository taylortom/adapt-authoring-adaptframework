async function VanillaTransform(data) {
  if(data._vanilla) {
    removeFalsy(data._vanilla);
  }
  if(data?._vanilla?._pageHeader) {
    removeFalsy(data._vanilla._pageHeader);
  }
}

function removeFalsy({ _backgroundImage, _backgroundStyles, _minimumHeights }) {
  if(_backgroundImage) {
    if(!_backgroundImage._large) delete _backgroundImage._large;
    if(!_backgroundImage._medium) delete _backgroundImage._medium;
    if(!_backgroundImage._small) delete _backgroundImage._small;
  }
  if(_backgroundStyles) {
    if(!_backgroundStyles._backgroundRepeat) delete _backgroundStyles._backgroundRepeat;
    if(!_backgroundStyles._backgroundSize) delete _backgroundStyles._backgroundSize;
    if(!_backgroundStyles._backgroundPosition) delete _backgroundStyles._backgroundPosition;
  }
  if(_minimumHeights) {
    if(!_minimumHeights._large) delete _minimumHeights._large;
    if(!_minimumHeights._medium) delete _minimumHeights._medium;
    if(!_minimumHeights._small) delete _minimumHeights._small;
  }
}

export default VanillaTransform;