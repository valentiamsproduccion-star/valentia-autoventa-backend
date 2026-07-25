// Motor de plantillas mínimo, estilo Mustache, sin dependencias externas.
// Soporta: {{var}} (con escape HTML), {{#seccion}}...{{/seccion}} (bucles y
// condicionales de verdad), {{^seccion}}...{{/seccion}} (negación), {{.}}
// dentro de listas de strings, y contexto anidado con búsqueda hacia arriba
// (como el Mustache real).
//
// Es deliberadamente pequeño: solo implementa lo que usan las 3 plantillas
// de Valentia. No pretende ser una librería Mustache completa.

'use strict';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lookup(stack, key) {
  if (key === '.') return stack[stack.length - 1];
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx != null && typeof ctx === 'object' && Object.prototype.hasOwnProperty.call(ctx, key)) {
      return ctx[key];
    }
  }
  return undefined;
}

function isTruthy(val) {
  if (Array.isArray(val)) return val.length > 0;
  if (val == null) return false;
  return val !== false && val !== '';
}

// Encuentra la etiqueta de cierre correspondiente a una apertura de sección,
// respetando el anidamiento de secciones con el mismo nombre.
function findSectionEnd(template, name, startIndex) {
  const openTag = new RegExp('\\{\\{[#^]' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}\\}', 'g');
  const closeTag = '{{/' + name + '}}';
  let depth = 1;
  let searchFrom = startIndex;
  while (depth > 0) {
    const closeIdx = template.indexOf(closeTag, searchFrom);
    if (closeIdx === -1) throw new Error('Mustache: falta {{/' + name + '}}');
    openTag.lastIndex = searchFrom;
    const openMatch = openTag.exec(template);
    if (openMatch && openMatch.index < closeIdx) {
      depth++;
      searchFrom = openMatch.index + openMatch[0].length;
    } else {
      depth--;
      if (depth === 0) return closeIdx;
      searchFrom = closeIdx + closeTag.length;
    }
  }
}

function render(template, context, stack) {
  stack = stack || [context];
  let out = '';
  let i = 0;
  const tagRe = /\{\{([#^\/]?)([\w.]+)\}\}/g;

  while (i < template.length) {
    tagRe.lastIndex = i;
    const m = tagRe.exec(template);
    if (!m) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, m.index);
    const [full, sigil, name] = m;

    if (sigil === '#' || sigil === '^') {
      const bodyStart = m.index + full.length;
      const bodyEnd = findSectionEnd(template, name, bodyStart);
      const body = template.slice(bodyStart, bodyEnd);
      const val = lookup(stack, name);
      const truthy = isTruthy(val);

      if (sigil === '^') {
        if (!truthy) out += render(body, context, stack);
      } else {
        if (Array.isArray(val)) {
          for (const item of val) {
            out += render(body, item, stack.concat([item]));
          }
        } else if (truthy) {
          out += render(body, val, stack.concat([val]));
        }
      }
      i = bodyEnd + ('{{/' + name + '}}').length;
      continue;
    }

    if (sigil === '/') {
      // No debería llegar aquí si las secciones están bien formadas;
      // simplemente lo saltamos.
      i = m.index + full.length;
      continue;
    }

    // Variable simple, con escape HTML.
    const val = lookup(stack, name);
    out += val == null ? '' : escapeHtml(val);
    i = m.index + full.length;
  }

  return out;
}

module.exports = { render, escapeHtml };
