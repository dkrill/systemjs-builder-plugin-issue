import compiler from 'dustjs-compiler';
import dust from 'dustjs-linkedin';

function getTemplateName(name) {
  const extension = name.substring(name.lastIndexOf('.'));
  const path = name.slice(0, -(extension.length));
  const indexOf = path.lastIndexOf('/');

  return name.slice((indexOf === -1) ? 0 : indexOf + 1, -(extension.length));
}

export function translate(load) {
  const templateName = getTemplateName(load.address.substr(load.address.lastIndexOf('/') + 1));

  const template = load.source;
  let compiled;
  if (template.indexOf('(function(){dust.register') === 0 || template.indexOf('(function(dust){dust.register') === 0) {
    compiled = template;
  } else {
    compiled = compiler.compile(template, templateName);
  }
  dust.loadSource(compiled);

  return 'import dust from "dustjs-linkedin";' + compiled + 'export default "' + templateName + '";';
}
