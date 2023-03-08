async function GraphicSrcTransform(data) {
  if(data._component !== 'graphic' && data._component !== 'hotgraphic') {
    return;
  }
  ([data].concat(data._items ?? [])).forEach(i => {
    if(i._graphic.src) i._graphic.large = i._graphic.small = i._graphic.src;
  });
}

export default GraphicSrcTransform;