async function GraphicSrcTransform(data) {
  if(data._component !== 'graphic' && data._component !== 'hotgraphic') {
    return;
  }
  if(!data._graphic.src) {
    return;
  }
  data._graphic.large = data._graphic.small = data._graphic.src;
}

export default GraphicSrcTransform;