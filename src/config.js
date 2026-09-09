(() => {
  const names = {
    ' ': 'SPACE', Escape: 'ESC', Enter: 'CR', Backspace: 'BS', Tab: 'TAB',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Delete: 'Del', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert',
  };
  const defaults = {
    registerPrefix: '"', allowCountPrefix: true, mappingTimeoutMs: 500,
    tokenAliases: { '<C-[>': '<ESC>' },
    cancelTokens: ['<ESC>', '<C-C>'],
  };
  const modes = ['normal', 'visual', 'visualLine', 'insert'];
  const sections = ['motions', 'operators', 'textObjects', 'operatorSelf', 'commands'];
  const isChar = value => typeof value === 'string' && Array.from(value).length === 1;

  function eventToToken(event) {
    if (event.isComposing || event.key === 'Dead' || event.key === 'Process' ||
        event.getModifierState?.('AltGraph')) return null;
    const key = event.key;
    if (!key) return null;
    const chord = event.ctrlKey || event.altKey || event.metaKey;
    if (isChar(key) && !chord && key !== ' ') return key;
    const name = names[key] || (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) ? key :
      (isChar(key) ? key.toUpperCase() : null));
    if (!name) return null;
    const modifiers = [event.ctrlKey && 'C', event.altKey && 'A', event.metaKey && 'M', event.shiftKey && 'S'].filter(Boolean);
    return `<${modifiers.length ? modifiers.join('-') + '-' : ''}${name}>`;
  }

  function validToken(token, placeholder = true) {
    if (isChar(token)) return !/[\x00-\x1f\x7f]/.test(token);
    if (placeholder && token === '<char>') return true;
    if (typeof token !== 'string' || !token.startsWith('<') || !token.endsWith('>')) return false;
    let body = token.slice(1, -1);
    let chord = false;
    for (const modifier of ['C-', 'A-', 'M-', 'S-']) {
      if (body.startsWith(modifier)) { body = body.slice(2); if (modifier !== 'S-') chord = true; }
    }
    return Object.values(names).includes(body) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(body) ||
      (chord && isChar(body) && body !== ' ' && body === body.toUpperCase());
  }

  const normalizeToken = token => token === ' ' ? '<SPACE>' : token;
  function validate(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'Configuration must be an object';
    if (config.settings !== undefined && (!config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings))) return 'settings must be an object';
    const settings = { ...defaults, ...config.settings };
    if (!validToken(settings.registerPrefix, false)) return 'registerPrefix must be a supported key token';
    for (const name of ['allowCountPrefix', 'allowRegisterPrefix']) {
      if (settings[name] !== undefined && typeof settings[name] !== 'boolean') return `${name} must be true or false`;
    }
    if (!Number.isFinite(settings.mappingTimeoutMs) || settings.mappingTimeoutMs < 50 || settings.mappingTimeoutMs > 10000) return 'mappingTimeoutMs must be between 50 and 10000';
    const aliases = settings.tokenAliases;
    if (!Array.isArray(settings.cancelTokens) || settings.cancelTokens.some(k => !validToken(k, false))) return 'cancelTokens must be a list of supported key tokens';
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return 'tokenAliases must be an object';
    for (const [from, to] of Object.entries(aliases)) {
      if (!validToken(from, false) || !validToken(to, false) || from === to || Object.hasOwn(aliases, to)) return 'Aliases must map supported tokens directly, without cycles or chains';
    }
    for (const section of sections) {
      if (config[section] !== undefined && !Array.isArray(config[section])) return `${section} must be a list`;
      const items = config[section] || [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const label = `${section}[${index + 1}]`;
        if (!item || typeof item !== 'object') return `${label} must be an object`;
        if (section !== 'operatorSelf' && (typeof item.id !== 'string' || !item.id)) return `${label} needs an ID`;
        if (!Array.isArray(item.keys) || !item.keys.length || item.keys.some(k => !validToken(k))) return `${label} needs supported, nonempty key tokens`;
        if (item.keys.some(k => Object.hasOwn(aliases, k))) return `${label}: remove the key's tokenAliases entry before binding it`;
        if (section === 'commands' && item.modes !== undefined && (!Array.isArray(item.modes) || !item.modes.length || item.modes.some(m => !modes.includes(m)))) return `${label} needs supported modes`;
        if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some(a => !a || typeof a.name !== 'string'))) return `${label} has invalid arguments`;
        const hasChar = (item.args || []).some(a => a.type === 'char');
        const placeholders = item.keys.filter(k => k === '<char>').length;
        if (placeholders && (!['motions', 'commands'].includes(section) || placeholders !== 1 || item.keys.at(-1) !== '<char>')) return `${label}: <char> must appear once, at the end of a motion or command`;
        if (hasChar && !placeholders) return `${label} requires a final <char> argument`;
        if (section === 'operatorSelf' && (typeof item.operator !== 'string' || item.target?.type !== 'line')) return `${label} needs an operator and a line target`;
        if (section === 'textObjects') {
          if (typeof item.type !== 'string' || !item.type) return `${label} needs a text object type`;
          if (item.delims !== undefined && (!Array.isArray(item.delims) || item.delims.length !== 2 || item.delims.some(d => !isChar(d)))) return `${label} needs two single-character delimiters`;
        }
        const activeModes = section === 'commands' ? (item.modes || ['normal']) : ['normal'];
        if (activeModes.includes('normal') && settings.allowCountPrefix && /^[1-9]$/.test(item.keys[0])) return `${label}: set allowCountPrefix to false to bind count digits`;
        if (activeModes.includes('normal') && settings.allowRegisterPrefix && item.keys[0] === settings.registerPrefix) return `${label}: change or disable registerPrefix before binding this key`;
        for (let previous = 0; previous < index; previous++) {
          const other = items[previous];
          const sameKeys = JSON.stringify(other.keys.map(normalizeToken)) === JSON.stringify(item.keys.map(normalizeToken));
          const overlap = section !== 'commands' || (other.modes || ['normal']).some(m => activeModes.includes(m));
          if (sameKeys && overlap) return `${label}: duplicate binding ${item.keys.join(' ')}`;
          const a = other.keys.map(normalizeToken), b = item.keys.map(normalizeToken);
          const prefix = a.length !== b.length && a.slice(0, Math.min(a.length, b.length)).every((key, i) => key === b[i]);
          if (prefix && overlap) return `${label}: a shorter binding in this section would hide the longer sequence`;
        }
      }
    }
    // Commands and motions use the same input stream within each mode.
    // Operator/text-object overlaps in Visual mode are intentional, because
    // Visual commands act on the existing selection instead of starting an operator.
    for (const mode of modes) {
      const entries = (config.commands || []).filter(c => (c.modes || ['normal']).includes(mode));
      if (mode !== 'insert') entries.push(...(config.motions || []));
      if (mode === 'normal') entries.push(...(config.operators || []), ...(config.operatorSelf || []));
      if (mode === 'visual' || mode === 'visualLine') entries.push(...(config.textObjects || []));
      const seen = new Set();
      for (const item of entries) {
        const key = JSON.stringify(item.keys.map(normalizeToken));
        if (seen.has(key)) return `${mode}: conflicting binding ${item.keys.join(' ')}`;
        seen.add(key);
      }
    }
    return null;
  }
  window.VimConfig = { defaults, eventToToken, validToken, validate, normalizeToken };
})();
