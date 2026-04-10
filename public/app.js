(function () {
  // markdown-it runs with html:false, so any raw HTML in user input is
  // escaped by the parser before it reaches the DOM. We still avoid
  // innerHTML and reparse through DOMParser as a second layer of defence.
  var md = window.markdownit({ html: false, linkify: true, typographer: true, breaks: false });
  var parser = new DOMParser();
  var editor = document.getElementById('editor');
  var preview = document.getElementById('preview');
  var drop = document.getElementById('drop');
  var fileInput = document.getElementById('file');
  var convertBtn = document.getElementById('convert');
  var banner = document.getElementById('banner');

  var SAMPLE = [
    '# Welcome to md2pdf',
    '',
    'Drop a `.md` file on the left or start typing here. The preview updates as you go.',
    '',
    '## Features',
    '',
    '- Markdown rendered to styled PDF',
    '- Live preview',
    '- Files auto-expire after 30 minutes',
    '',
    '```js',
    'console.log("hello, pdf");',
    '```',
  ].join('\n');
  editor.value = SAMPLE;
  render();

  editor.addEventListener('input', render);

  function render() {
    var htmlString = md.render(editor.value || '');
    // Parse into a detached document, then move the nodes into the preview
    // container. Scripts from a parsed document never execute (by spec), and
    // markdown-it has already escaped any raw HTML.
    var doc = parser.parseFromString('<body>' + htmlString + '</body>', 'text/html');
    while (preview.firstChild) preview.removeChild(preview.firstChild);
    var body = doc.body;
    while (body.firstChild) preview.appendChild(body.firstChild);
  }

  function showError(msg) {
    banner.textContent = msg;
    banner.classList.add('visible');
  }
  function clearError() {
    banner.classList.remove('visible');
    banner.textContent = '';
  }

  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.remove('dragging');
    });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
  });

  function loadFile(file) {
    clearError();
    if (file.size > 5 * 1024 * 1024) {
      showError('File exceeds 5 MB limit.');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      editor.value = String(reader.result || '');
      render();
    };
    reader.onerror = function () {
      showError('Could not read file.');
    };
    reader.readAsText(file);
  }

  convertBtn.addEventListener('click', async function () {
    clearError();
    var body = editor.value || '';
    if (!body.trim()) {
      showError('Editor is empty.');
      return;
    }
    convertBtn.disabled = true;
    var originalLabel = convertBtn.textContent;
    convertBtn.textContent = 'Converting…';
    try {
      var r = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: body }),
      });
      var data = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) {
        throw new Error(data.error || 'Conversion failed (' + r.status + ').');
      }
      window.location.href = data.url;
    } catch (err) {
      showError(err.message || 'Something went wrong.');
    } finally {
      convertBtn.disabled = false;
      convertBtn.textContent = originalLabel;
    }
  });
})();
