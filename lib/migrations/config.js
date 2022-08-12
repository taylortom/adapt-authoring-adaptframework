async function ConfigTransform(data) {
  if(data._type !== 'config' || !data._accessibility._ariaLevels) {
    return;
  }
  data._accessibility._ariaLevels._menu = String(data._accessibility._ariaLevels._menu);
  data._accessibility._ariaLevels._menuItem = String(data._accessibility._ariaLevels._menuItem);
  data._accessibility._ariaLevels._page = String(data._accessibility._ariaLevels._page);
  data._accessibility._ariaLevels._article = String(data._accessibility._ariaLevels._article);
  data._accessibility._ariaLevels._block = String(data._accessibility._ariaLevels._block);
  data._accessibility._ariaLevels._component = String(data._accessibility._ariaLevels._component);
  data._accessibility._ariaLevels._componentItem = String(data._accessibility._ariaLevels._componentItem);
  data._accessibility._ariaLevels._notify = String(data._accessibility._ariaLevels._notify);
}

export default ConfigTransform;