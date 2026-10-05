/** Read selection without exposing passwords or overwriting clipboard with an empty value. */
export const BROWSER_CONTEXT_SCRIPT = `JSON.stringify((() => {
  const element = document.activeElement;
  let selection = '';
  if (element instanceof HTMLInputElement && element.type === 'password') {
    return {title:document.title,url:location.href,selection};
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number')
      selection = element.value.slice(element.selectionStart, element.selectionEnd);
  } else selection = String(getSelection());
  return {title:document.title,url:location.href,selection:selection.slice(0,16000)};
})())`
