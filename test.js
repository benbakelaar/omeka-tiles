// Bare fetch test: no app code involved. Result shows on the page and in the console.
const out = document.getElementById('out');
fetch('https://edisondigital.rutgers.edu/api/items/1')
  .then(r => r.json())
  .then(data => { console.log(data); out.textContent = 'SUCCESS:\n' + JSON.stringify(data, null, 2); })
  .catch(err => { console.error(err); out.textContent = 'FAILED: ' + err.message; });
