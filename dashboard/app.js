(() => {
  const pages = [
    'Overview',
    'Emergency Mapping',
    'Network Analysis',
    'Predictive Analytics (Demo)',
    'Hotspot Heatmaps',
    'Accessibility',
    'Facility Optimization',
    'Planning Recommendations',
    'Priority Zones',
    'Dispatch Center',
    'Reports & Analytics'
  ];
  const emptyGeo = { type: 'FeatureCollection', features: [] };
  const colors = { Low: '#2dd4bf', Moderate: '#facc15', High: '#f59e0b', 'Very High': '#f0524a' };
  const loaded = {
    hospitals: emptyGeo,
    fire: emptyGeo,
    roads: emptyGeo,
    boundary: emptyGeo,
    localities: emptyGeo,
    demand: emptyGeo,
    priorityZones: emptyGeo,
    incidents: emptyGeo,
    serviceHospitals: emptyGeo,
    serviceFire: emptyGeo,
    recommended: emptyGeo,
    populationMeta: null
  };
  const mapRefs = {};
  const chartRefs = [];
  let incidentLayer = null;
  let routeLayer = null;
  let mapClickHandler = null;
  let currentLocation = null;
  let selectedFacility = null;
  let locationWatchId = null;
  let nearbyRequestId = 0;
  let dispatchAnimationFrame = null;
  let dispatchUnitMarker = null;
  let dispatchNearbyLayer = null;

  Object.assign(state, { activePage: 'Overview', kpis: {}, stats: {}, optimization: {}, map: null });

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const features = geo => Array.isArray(geo?.features) ? geo.features : [];
  const props = feature => feature?.properties || {};
  const facilityName = feature => {
    const item = props(feature);
    const name = item.name || item['name:en'] || item['name:ur'];
    return typeof name === 'string' && name.trim() && name.trim().toLocaleLowerCase() !== 'unnamed'
      ? name.trim() : '';
  };
  const isEmergencyHospital = feature => {
    const name = facilityName(feature);
    const emergencyTag = String(props(feature).emergency || '').trim().toLocaleLowerCase();
    const hasEmergencyService = emergencyTag && !['no', 'false', '0', 'none', 'unknown'].includes(emergencyTag);
    return Boolean(name && !['no', 'false', '0', 'none'].includes(emergencyTag)
      && (/hospital/i.test(name) || hasEmergencyService));
  };
  const distanceKm = (first, second) => {
    const toRadians = value => value * Math.PI / 180;
    const latDelta = toRadians(second.lat - first.lat);
    const lonDelta = toRadians(second.lon - first.lon);
    const a = Math.sin(latDelta / 2) ** 2
      + Math.cos(toRadians(first.lat)) * Math.cos(toRadians(second.lat)) * Math.sin(lonDelta / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  const values = key => features(loaded.demand)
    .map(feature => Number(props(feature)[key]))
    .filter(Number.isFinite);
  const mean = vals => vals.length ? vals.reduce((sum, value) => sum + value, 0) / vals.length : null;
  const fmt = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
  const heatColor = (value, minimum, maximum) => {
    const stops = ['#3b82f6', '#22c55e', '#facc15', '#f59e0b', '#ef4444'];
    const ratio = maximum > minimum ? Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum))) : 0;
    const position = ratio * (stops.length - 1);
    const index = Math.min(Math.floor(position), stops.length - 2);
    const fraction = position - index;
    const parse = color => color.match(/[a-f\d]{2}/gi).map(channel => parseInt(channel, 16));
    const start = parse(stops[index]), end = parse(stops[index + 1]);
    return `rgb(${start.map((channel, i) => Math.round(channel + (end[i] - channel) * fraction)).join(',')})`;
  };
  const statusText = message => {
    let node = document.getElementById('dataStatus');
    if (!node) {
      node = document.createElement('div');
      node.id = 'dataStatus';
      node.setAttribute('role', 'status');
      node.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2000;max-width:380px;padding:10px 14px;border:1px solid #38536c;border-radius:8px;background:#102338;color:#dcecff;font:12px Segoe UI,sans-serif;box-shadow:0 10px 30px #0008';
      document.body.appendChild(node);
    }
    node.textContent = message;
  };
  const geoFetch = async file => {
    const response = await fetch(`data/${file}`);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    return response.json();
  };
  const jsonFetch = async file => {
    const response = await fetch(`data/${file}`);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    return response.json();
  };

  function iconFor(name) {
    const icons = {
      'Overview': '◉', 'Emergency Mapping': '⌖', 'Network Analysis': '⇄',
      'Predictive Analytics (Demo)': '✦', 'Hotspot Heatmaps': '⌁', 'Accessibility': '◌', 'Facility Optimization': '▣',
      'Planning Recommendations': '☼', 'Priority Zones': '◈', 'Dispatch Center': '⚑', 'Reports & Analytics': '▤'
    };
    return icons[name] || '•';
  }

  function showDispatchNearbyFacilities(map, nearby) {
    if (mapRefs.hospitals && map.hasLayer(mapRefs.hospitals)) map.removeLayer(mapRefs.hospitals);
    if (mapRefs.fire && map.hasLayer(mapRefs.fire)) map.removeLayer(mapRefs.fire);
    if (dispatchNearbyLayer && map.hasLayer(dispatchNearbyLayer)) map.removeLayer(dispatchNearbyLayer);
    dispatchNearbyLayer = L.layerGroup();
    const facilities = facilityCatalog();
    [['hospital', 'hospital-map-icon', 'H'], ['fire', 'fire-map-icon', 'F']].forEach(([kind, iconClass, letter]) => {
      (nearby[kind] || []).forEach(entry => {
        const item = facilities.find(candidate => candidate.kind === kind && candidate.index === entry.index);
        if (!item) return;
        const icon = L.divIcon({
          className: `facility-map-icon ${iconClass}`,
          html: `<span>${letter}</span>`,
          iconSize: [25, 25],
          iconAnchor: [12, 23],
          popupAnchor: [0, -21]
        });
        const marker = L.marker([item.lat, item.lon], { icon, title: item.name, alt: item.name });
        marker.bindPopup(facilityPopup(item.feature, kind, item.index), popupOptions(map));
        marker.bindTooltip(`${esc(item.name)} · ${fmt(entry.distance_km, 1)} km`, { direction: 'top', offset: [0, -6] });
        marker.addTo(dispatchNearbyLayer);
      });
    });
    dispatchNearbyLayer.addTo(map);
  }

  function buildNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = pages.map(page => `
      <button type="button" class="nav-btn ${state.activePage === page ? 'active' : ''}" data-page="${esc(page)}">
        <span class="icon">${iconFor(page)}</span><span>${esc(page)}</span>
      </button>`).join('');
    nav.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
      state.activePage = button.dataset.page;
      history.replaceState(null, '', `#${encodeURIComponent(state.activePage)}`);
      buildNav();
      renderFeatureWindow();
    }));
  }

  function renderKpis() {
    const demand = features(loaded.demand);
    const priority = demand.filter(feature => props(feature).priority === 'Very High').length;
    const demo = state.stats.demo === true;
    const metrics = [
      { label: 'Hospitals', value: state.kpis.hospitals ?? features(loaded.hospitals).length, note: 'OpenStreetMap facilities', icon: '🏥' },
      { label: 'Fire stations', value: state.kpis.fire_stations ?? features(loaded.fire).length, note: 'OpenStreetMap facilities', icon: '🚒' },
      { label: 'Incident records', value: state.stats.n ?? features(loaded.incidents).length, note: demo ? 'Simulated demo records' : 'Loaded incident records', icon: '⚠' },
      { label: 'Mean hospital access', value: `${fmt(state.kpis.mean_hosp_min)} min`, note: 'Free-flow road-network estimate', icon: '⏱' },
      { label: 'Hospital access ≤10 min', value: `${fmt(state.kpis.hosp_within_10)}%`, note: 'Road nodes, not population', icon: '⌖' },
      { label: 'Slowest-quartile nodes', value: priority || '0', note: demand.length ? `${fmt(priority / demand.length * 100)}% of sampled road nodes` : 'Share unavailable', icon: '◈' }
    ];
    document.getElementById('kpis').innerHTML = metrics.map(metric => `
      <div class="kpi-card">
        <div class="top"><span>${esc(metric.label)}</span><span class="icon-box">${metric.icon}</span></div>
        <div class="value">${esc(metric.value)}</div>
        <div class="meta"><span>${esc(metric.note)}</span><span class="up">${demo && metric.label === 'Incident records' ? 'DEMO' : ''}</span></div>
      </div>`).join('');
  }

  function renderSummaryPanel() {
    const demoNotice = state.stats.demo
      ? '<div class="data-note warning">Incident records and incident-derived metrics are simulated. They are not verified emergency history.</div>'
      : '<div class="data-note">Incident summaries use the loaded incident dataset.</div>';
    const forecast = state.stats.forecast || [];
    const nextDemand = forecast.length ? mean(forecast.map(item => item.expected)) : null;
    const incidents = features(loaded.incidents).slice(0, 5);
    document.getElementById('summaryPanel').innerHTML = `
      ${demoNotice}
      <div class="mini-card">
        <h4>Analysis status</h4>
        <div class="prediction-row"><span>Hotspot data</span><strong>${state.stats.demo ? 'Simulated only' : (incidents.length ? `${incidents.length} records` : 'Unavailable')}</strong></div>
        <div class="prediction-row"><span>Mean network access</span><strong>${fmt(state.kpis.mean_hosp_min)} min hospital</strong></div>
        <div class="prediction-row"><span>Demand baseline</span><strong>${nextDemand === null ? 'Unavailable' : `${fmt(nextDemand)} / day`}</strong></div>
        <div class="prediction-row"><span>Model validation</span><strong>${state.stats.demo ? 'Demo only' : (state.stats.mae == null ? 'Unavailable' : 'See AI page')}</strong></div>
      </div>
      <div class="mini-card" style="margin-top:12px">
        <h4>Latest loaded records</h4>
        <div class="recent-list">${incidents.length ? incidents.map(feature => {
          const item = props(feature);
          const kind = esc(item.type || 'Incident');
          const hour = Number.isFinite(Number(item.hour)) ? `${String(item.hour).padStart(2, '0')}:00` : 'Time n/a';
          return `<div class="incident-item"><div><div class="incident-name">${kind}</div><span class="incident-meta">${hour} · ${fmt(item.est)} min network estimate</span></div><span class="tag ${item.actual > 15 ? 'high' : 'medium'}">${state.stats.demo ? 'Demo' : 'Record'}</span></div>`;
        }).join('') : '<div class="data-note">No incident file is loaded.</div>'}</div>
      </div>`;
  }

  function mapShell(id, extra = '') {
    const overviewKey = '<div class="map-key"><div class="map-key-item"><span class="facility-map-icon hospital-map-icon" style="width:18px!important;height:18px!important"><span>H</span></span> Hospital</div><div class="map-key-item"><span class="facility-map-icon fire-map-icon" style="width:18px!important;height:18px!important"><span>F</span></span> Fire station</div><div class="map-key-item"><span class="locality-map-swatch">Aa</span> Area names</div><div class="map-key-item"><span style="width:15px;border-top:2px solid #2dd4bf"></span> Study boundary</div><div class="map-key-item"><span class="heatmap-ramp"></span> Access samples · low to high</div></div>';
    const networkKey = '<div class="map-key network-map-key"><div class="map-key-item"><span class="network-key-line hospital-route-key"></span> Route to hospital</div><div class="map-key-item"><span class="network-key-line fire-route-key"></span> Route to fire station</div><div class="map-key-item"><span class="network-key-origin"></span> Origin</div><div class="map-key-item"><span class="network-key-area"></span> 10-minute service area</div></div>';
    const accessibilityKey = '<div class="map-key accessibility-map-key"><strong>Travel time</strong><div class="map-key-item"><span class="access-key-swatch" style="background:#2dd4bf"></span> ≤5 min</div><div class="map-key-item"><span class="access-key-swatch" style="background:#facc15"></span> 5–10 min</div><div class="map-key-item"><span class="access-key-swatch" style="background:#f59e0b"></span> 10–15 min</div><div class="map-key-item"><span class="access-key-swatch" style="background:#f0524a"></span> &gt;15 min</div><div class="map-key-item"><span class="access-key-swatch" style="background:#8492a6"></span> Unavailable</div></div>';
    const optimizationKey = '<div class="map-key optimization-map-key"><div class="map-key-item"><span class="facility-map-icon hospital-map-icon" style="width:18px!important;height:18px!important"><span>H</span></span> Hospital</div><div class="map-key-item"><span class="facility-map-icon fire-map-icon" style="width:18px!important;height:18px!important"><span>F</span></span> Fire station</div><div class="map-key-item"><span class="optimization-candidate-swatch"></span> Candidate for assessment</div></div>';
    const priorityKey = '<div class="map-key priority-map-key"><strong>Mean slower-service time</strong><div class="map-key-item"><span class="access-key-swatch" style="background:#2dd4bf"></span> ≤5 min</div><div class="map-key-item"><span class="access-key-swatch" style="background:#facc15"></span> 5–10 min</div><div class="map-key-item"><span class="access-key-swatch" style="background:#f59e0b"></span> 10–15 min</div><div class="map-key-item"><span class="access-key-swatch" style="background:#f0524a"></span> &gt;15 min</div><small>Average hospital/fire time per 500 m cell</small></div>';
    return `<div class="map-toolbar">${extra}</div><div class="map-frame"><div id="${id}" class="page-map"></div>${id === 'overviewMap' ? overviewKey : id === 'networkMap' ? networkKey : id === 'accessibilityMap' ? accessibilityKey : id === 'optimizationMap' ? optimizationKey : id === 'priorityMap' ? priorityKey : ''}</div>`;
  }

  function facilityCatalog() {
    return [
      ...features(loaded.hospitals).map((feature, index) => ({ feature, kind: 'hospital', index })),
      ...features(loaded.fire).map((feature, index) => ({ feature, kind: 'fire', index }))
    ].map(({ feature, kind, index }) => {
      const item = props(feature);
      const name = facilityName(feature);
      const type = kind === 'fire' && item.amenity !== 'fire_station' ? item.emergency || 'Emergency service'
        : kind === 'fire' ? 'Fire station' : isEmergencyHospital(feature) ? 'Hospital' : 'Clinic';
      const [lon, lat] = feature.geometry.coordinates;
      return { feature, kind, index, name, type, lat, lon, display: `${name} — ${type} (${lat.toFixed(5)}, ${lon.toFixed(5)})` };
    }).filter(item => item.name && (item.kind !== 'fire' || props(item.feature).amenity === 'fire_station'));
  }

  function facilitySearchMarkup() {
    const options = facilityCatalog().map(item => `<option value="${esc(item.display)}"></option>`).join('');
    return `
      <div class="control-row"><button type="button" class="tool-button" id="useCurrentLocation">Use My Current Location</button><button type="button" class="tool-button" id="findNearbyServices">Find nearby emergency services</button><button type="button" class="tool-button" id="recalculateFacilityRoute" hidden>Recalculate route</button></div>
      <div class="control-row"><input id="facilitySearch" type="search" list="facilityChoices" placeholder="Search a hospital, clinic, or fire station" aria-label="Search a facility"><datalist id="facilityChoices">${options}</datalist><button type="button" class="tool-button" id="searchFacility">Find</button><button type="button" class="tool-button" id="routeSelectedFacility">Route to selected</button></div>
      <div id="searchResult" class="data-note" role="status">Search the loaded hospital and emergency-facility records, use your location, or select a destination for directions.</div>`;
  }

  function renderOverview() {
    const coverage = key => {
      const sample = values(key);
      return sample.length ? Math.round(sample.filter(value => value <= 10).length / sample.length * 100) : null;
    };
    const hospitalCoverage = coverage('hosp_min');
    const fireCoverage = coverage('fire_min');
    const highestRisk = features(loaded.demand).slice().sort((first, second) => {
      const access = feature => Math.max(Number(props(feature).hosp_min) || 0, Number(props(feature).fire_min) || 0);
      return access(second) - access(first);
    }).slice(0, 5);
    const riskRows = highestRisk.map((feature, index) => {
      const item = props(feature);
      const coordinates = feature.geometry?.coordinates || [];
      const severity = item.priority || 'Unclassified';
      return `<tr><td>${index + 1}</td><td>${esc(severity)}</td><td>${fmt(item.hosp_min)} min</td><td>${fmt(item.fire_min)} min</td><td>${coordinates.length >= 2 ? `${Number(coordinates[1]).toFixed(3)}, ${Number(coordinates[0]).toFixed(3)}` : 'n/a'}</td></tr>`;
    }).join('');
    return `
      <div class="page-card map-card">
        <h3>Rawalpindi emergency intelligence map</h3>
        ${mapShell('overviewMap', '<span>Area names · hospitals · fire stations · boundary</span>')}
      </div>
      <div class="page-card"><h3>10-minute road-node coverage</h3>
        <div class="coverage-donuts">
          <div><div class="coverage-donut" style="--coverage:${hospitalCoverage ?? 0}%;--coverage-color:#4da3ff"><span>${hospitalCoverage === null ? '—' : `${hospitalCoverage}%`}<small>HOSPITAL</small></span></div><p class="data-note chart-explanation">${hospitalCoverage === null ? 'Hospital access samples are unavailable.' : `${hospitalCoverage}% of sampled road nodes reach a hospital within 10 minutes.`}</p></div>
          <div><div class="coverage-donut" style="--coverage:${fireCoverage ?? 0}%;--coverage-color:#f0524a"><span>${fireCoverage === null ? '—' : `${fireCoverage}%`}<small>FIRE</small></span></div><p class="data-note chart-explanation">${fireCoverage === null ? 'Fire-station access samples are unavailable.' : `${fireCoverage}% of sampled road nodes reach a fire station within 10 minutes.`}</p></div>
        </div>
      </div>
      <div class="page-card"><h3>Hospital access-time distribution</h3><div class="chart-wrap"><canvas id="overviewResponseHistogram"></canvas></div><p class="data-note chart-explanation">Road-node estimates in five-minute bands; not measured response times.</p></div>
      <div class="page-card"><h3>Highest access-risk samples</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>Class</th><th>Hospital</th><th>Fire</th><th>Lat, lon</th></tr></thead><tbody>${riskRows || '<tr><td colspan="5">Road-node access samples are unavailable.</td></tr>'}</tbody></table></div><p class="data-note chart-explanation">Ranked by the slower estimated route; coordinates identify samples, not named neighborhoods.</p><div id="overviewStatus" class="data-note"></div></div>`;
  }

  function renderMapping() {
    return `
      <div class="page-card map-card"><h3>Interactive emergency mapping</h3>
        ${mapShell('mappingMap', `<label><input type="checkbox" data-map-layer="roads" checked> Road network</label><label><input type="checkbox" data-map-layer="hospitals" checked> Hospitals</label><label><input type="checkbox" data-map-layer="fire" checked> Fire stations</label><label><input type="checkbox" data-map-layer="demand"> Access sample</label><label><input type="checkbox" data-map-layer="incidents"> Incidents</label><label><input type="checkbox" data-map-layer="service"> 10-min service areas</label>${loaded.populationMeta ? '<label><input type="checkbox" data-map-layer="population"> WorldPop 2025 population estimate</label><span class="population-legend"><span aria-hidden="true"></span> Estimated people/cell: lower to higher · alpha</span>' : '<span>WorldPop raster not prepared</span>'}<label><input type="checkbox" data-facility-labels> Show facility names</label>`)}
        ${facilitySearchMarkup()}
      </div>
      <div class="page-card"><h3>Data inventory</h3><div class="table-wrap"><table><tr><th>Layer</th><th>Status</th><th>Count</th></tr>
        <tr><td>Hospitals</td><td>OSM facilities; see directory</td><td>${features(loaded.hospitals).length}</td></tr>
        <tr><td>Fire stations</td><td>OSM</td><td>${features(loaded.fire).length}</td></tr>
        <tr><td>Road network</td><td>OSM drive graph</td><td>${features(loaded.roads).length} segments</td></tr>
        <tr><td>Access sample</td><td>Road nodes</td><td>${features(loaded.demand).length}</td></tr>
        <tr><td>Incidents</td><td>${state.stats.demo ? 'Simulated' : 'Loaded'}</td><td>${features(loaded.incidents).length}</td></tr>
        <tr><td>WorldPop ${loaded.populationMeta?.year || 'population'}</td><td>${loaded.populationMeta ? 'Modeled map overlay; not used in coverage calculations' : 'Not loaded'}</td><td>${loaded.populationMeta ? '3 arc-seconds' : '—'}</td></tr></table></div></div>
      ${hospitalDirectoryMarkup()}
      ${fireDirectoryMarkup()}`;
  }

  function hospitalDirectoryMarkup() {
    const hospitals = features(loaded.hospitals).filter(facilityName).slice().sort((a, b) =>
      facilityName(a).localeCompare(facilityName(b))
    );
    const rows = hospitals.map((feature, index) => {
      const item = props(feature);
      const name = facilityName(feature);
      const address = item['addr:full'] || [
        item['addr:housenumber'], item['addr:street'], item['addr:suburb'],
        item['addr:city'], item['addr:postcode']
      ].filter(Boolean).join(', ') || 'Not tagged in OpenStreetMap';
      const phone = item['contact:phone'] || item.phone || item.mobile || item['contact:mobile'] || 'Not tagged';
      const contact = [phone, item['contact:email'] || item.email].filter(value => value && value !== 'Not tagged').join(' · ') || 'Not tagged in OpenStreetMap';
      const service = item['healthcare:speciality'] || item['healthcare:specialty'] || item.service || 'Not tagged';
      const type = item.healthcare || item.amenity || item.emergency || 'Not tagged';
      const [lon, lat] = feature.geometry.coordinates;
      const detailRows = Object.entries(item)
        .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
        .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
      return `<tr>
        <td>${index + 1}</td>
        <td><strong>${esc(name)}</strong></td>
        <td>${esc(type)}</td>
        <td>${esc(address)}</td>
        <td>${esc(contact)}</td>
        <td>${esc(service)}</td>
        <td>${lat.toFixed(5)}, ${lon.toFixed(5)}</td>
        <td><details><summary>All tagged details</summary><dl>${detailRows || '<dd>No additional tags</dd>'}</dl></details></td>
      </tr>`;
    }).join('');
    return `<div class="page-card hospital-directory">
      <h3>Rawalpindi hospital and healthcare facility directory <span class="hospital-count">(${hospitals.length} mapped OSM records)</span></h3>
      <p class="data-note">Locations and details are from OpenStreetMap for this project’s 8 km city-centre study area. Contact, address, service, and operating-hours information appears only when mapped in OSM; untagged information is not inferred.</p>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Facility type</th><th>Address</th><th>Contact</th><th>Available services / specialty</th><th>Coordinates</th><th>More information</th></tr></thead><tbody>${rows || '<tr><td colspan="8">Hospital dataset is unavailable. Run scripts/01_download_data.py to refresh it.</td></tr>'}</tbody></table></div>
      <p class="data-note">OpenStreetMap contributors · hospital information may be incomplete or outdated. Verify with the facility before relying on it.</p>
    </div>`;
  }

  function fireDirectoryMarkup() {
    const stations = features(loaded.fire).filter(facilityName);
    const rows = stations.map((feature, index) => {
      const item = props(feature);
      const name = facilityName(feature);
      const type = item.amenity === 'fire_station' ? 'Fire station' : item.emergency || item.amenity || 'Emergency facility';
      const address = item['addr:full'] || [
        item['addr:housenumber'], item['addr:street'], item['addr:suburb'],
        item['addr:city'], item['addr:postcode']
      ].filter(Boolean).join(', ') || 'Not tagged in OpenStreetMap';
      const [lon, lat] = feature.geometry.coordinates;
      const details = Object.entries(item)
        .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
        .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
      return `<tr><td>${index + 1}</td><td><strong>${esc(name)}</strong></td><td>${esc(type)}</td><td>${esc(address)}</td><td>${lat.toFixed(5)}, ${lon.toFixed(5)}</td><td><details><summary>All tagged details</summary><dl>${details || '<dd>No additional tags</dd>'}</dl></details></td></tr>`;
    }).join('');
    return `<div class="page-card hospital-directory">
      <h3>Rawalpindi fire stations and emergency facilities <span class="hospital-count">(${stations.length} mapped OSM records)</span></h3>
      <p class="data-note">Locations and names are from OpenStreetMap in this project's 8 km study area. Records tagged as ambulance stations are identified separately; unnamed facilities and missing details are not inferred.</p>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Facility type</th><th>Address</th><th>Coordinates</th><th>More information</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No emergency facilities are available in the loaded dataset.</td></tr>'}</tbody></table></div>
    </div>`;
  }

  function renderNetwork() {
    const thresholds = [5, 10, 15, 20, 30];
    const coverageAt15 = key => {
      const sample = values(key);
      return sample.length ? sample.filter(value => value <= 15).length / sample.length * 100 : null;
    };
    const hospitalCoverage = coverageAt15('hosp_min');
    const fireCoverage = coverageAt15('fire_min');
    const coverageNote = hospitalCoverage === null || fireCoverage === null
      ? '15-minute access coverage is unavailable for one or both services.'
      : hospitalCoverage === 100 && fireCoverage === 100
        ? 'All sampled road nodes in this compact 8 km study area have estimated access to a hospital and fire station within 15 minutes.'
        : `At 15 minutes, estimated access covers ${fmt(hospitalCoverage)}% of sampled road nodes for hospitals and ${fmt(fireCoverage)}% for fire stations.`;
    return `
      <div class="network-layout">
        <div class="network-main">
          <div class="page-card map-card network-map-card"><h3>Closest facility &amp; road route</h3>
            ${mapShell('networkMap', '<label><input type="checkbox" data-map-layer="hospitals" checked> Hospitals</label><label><input type="checkbox" data-map-layer="fire" checked> Fire stations</label><label><input type="checkbox" data-map-layer="clinics"> Clinics</label><label><input type="checkbox" data-map-layer="roads"> Road network</label><label><input type="checkbox" data-map-layer="serviceHosp" checked> Hospital service area</label><label><input type="checkbox" data-map-layer="serviceFire"> Fire service area</label><span>Click the map to calculate routes.</span>')}
          </div>
          <div class="page-card network-results-card"><h3>Route results</h3>
            <div id="routeResults" class="route-results">Select an origin on the map to calculate routes.</div>
            <p class="data-note">Clinic records are not included as hospital destinations. Route estimates near the study-area boundary are less reliable because the available road network is clipped to the project boundary.</p>
          </div>
        </div>
        <div class="page-card network-coverage"><h3>Service-area thresholds</h3>
          <div class="control-row">${thresholds.map(minute => `<button class="tool-button ${minute === 10 ? 'selected' : ''}" data-service-minutes="${minute}">${minute} min</button>`).join('')}</div>
          <p id="serviceAreaStatus" class="data-note">10-minute hospital service area shown. Toggle the fire-station service area separately. Coverage is for sampled road nodes, not population.</p>
          <div class="chart-wrap"><canvas id="networkAccessChart"></canvas></div>
          <p class="data-note">${coverageNote} These percentages apply only to the project boundary and do not mean all of Rawalpindi district is covered.</p>
        </div>
      </div>
      `;
  }

  function renderAI() {
    const status = state.stats.demo
      ? '<div class="data-note warning">The incident file is simulated. Error metrics and charts below are demo diagnostics, not evidence of real-world model performance.</div>'
      : '<div class="data-note">Metrics are calculated from the available incident records. They do not establish deployment accuracy.</div>';
    return `
      ${status}
      <div class="page-card"><h3>1 · Incident locations and density</h3><div class="chart-wrap"><canvas id="incidentTypeChart"></canvas></div><p class="data-note">Incident count by category. No trained hotspot prediction model is available.</p></div>
      <div class="page-card"><h3>2 · Response-time estimate vs actual</h3><div class="chart-wrap"><canvas id="responseModelChart"></canvas></div><div class="table-wrap"><table><tr><th>Available diagnostic</th><th>Value</th></tr><tr><td>Records</td><td>${state.stats.n ?? 'n/a'}</td></tr><tr><td>MAE</td><td>${state.stats.mae == null ? 'n/a' : `${fmt(state.stats.mae, 2)} min`}</td></tr><tr><td>R² (squared correlation)</td><td>${state.stats.r2 ?? 'n/a'}</td></tr></table></div></div>
      <div class="page-card"><h3>3 · Demand baseline forecast</h3><div class="chart-wrap"><canvas id="forecastChart"></canvas></div><p class="data-note">Weekday-average baseline from the provided incident series; not an independently validated forecast.</p></div>
      <div class="page-card"><h3>4 · Transparent access-risk classes</h3><div class="chart-wrap"><canvas id="riskChart"></canvas></div><p class="data-note">Priority labels are an access-time index derived from network travel-time estimates, not a trained classifier.</p></div>
      <div class="page-card ai-analysis-note"><h3>5 · AI-assisted spatial analysis</h3><p class="data-note">Inputs available: sampled road-node coordinates, estimated hospital/fire access times, and incident records. The WorldPop population surface is a map overlay only and is not included in the access calculations. Verified incident history, traffic, and dispatch/arrival validation are not available. Outputs are descriptive scenarios only.</p></div>`;
  }

  function renderHeatmaps() {
    return `
      <div class="page-card map-card"><h3>Incident and access difficulty map</h3>
        ${mapShell('heatmapMap', '<label><input type="checkbox" data-map-layer="incidentsHeat" checked> Incident records · density</label><label><input type="checkbox" data-map-layer="demandHeat"> Hard-to-reach areas</label>')}
        <p class="data-note warning">${state.stats.demo ? 'Incident locations are simulated. The access layer is an index, not an incident hotspot forecast.' : 'Incident points are observed records; access classes are an index, not a trained hotspot forecast.'}</p>
      </div>
      <div class="page-card"><h3>Incident frequency by hour</h3><div class="chart-wrap"><canvas id="incidentHourChart"></canvas></div></div>
      <div class="page-card"><h3>Data interpretation</h3><p class="data-note">Heat intensity smooths the provided point locations for visualization only. It does not represent verified emergency incidence rates, population exposure, or causal risk.</p></div>`;
  }

  function renderAccessibility() {
    const hospitalBeyond15 = shareAboveThreshold('hosp_min', 15);
    const fireBeyond15 = shareAboveThreshold('fire_min', 15);
    return `
      <div class="page-card map-card accessibility-map-card"><h3>Estimated travel time to nearest service</h3>
        ${mapShell('accessibilityMap', '<label for="accessibilityService">Service</label><select id="accessibilityService"><option value="hosp_min">Hospital</option><option value="fire_min">Fire station</option></select>')}
        <p class="data-note">Estimated travel time for sampled road-network nodes; this is not population coverage or live traffic.</p>
      </div>
      <div class="page-card"><h3>Hospital access-time distribution</h3><div class="chart-wrap"><canvas id="hospitalAccessChart"></canvas></div><p class="data-note">Histogram of sampled road nodes; not population coverage.</p></div>
      <div class="page-card"><h3>Fire station access-time distribution</h3><div class="chart-wrap"><canvas id="fireAccessChart"></canvas></div><p class="data-note">Histogram of sampled road nodes; not population coverage.</p></div>
      <div class="page-card"><h3>Network-node coverage by threshold</h3><div class="chart-wrap"><canvas id="accessThresholdChart"></canvas></div><p class="data-note">Threshold coverage calculated from available sampled access points.</p></div>
      <div class="page-card"><h3>Accessibility summary</h3><div class="table-wrap"><table><tr><th>Service</th><th>≤10 min</th><th>&gt;15 min</th><th>Mean estimate</th></tr><tr><td>Hospital</td><td>${fmt(state.kpis.hosp_within_10)}%</td><td>${hospitalBeyond15 === null ? 'n/a' : `${fmt(hospitalBeyond15)}%`}</td><td>${fmt(state.kpis.mean_hosp_min)} min</td></tr><tr><td>Fire station</td><td>${fmt(state.kpis.fire_within_10)}%</td><td>${fireBeyond15 === null ? 'n/a' : `${fmt(fireBeyond15)}%`}</td><td>${fmt(state.kpis.mean_fire_min)} min</td></tr></table></div><p class="data-note">Shares are calculated over sampled road-network nodes, not population or residential zones.</p></div>`;
  }

  function renderOptimization() {
    const rows = features(loaded.recommended).map(feature => {
      const item = props(feature);
      return `<tr><td>${esc(item.type)}</td><td>${esc(item.rank)}</td><td>${fmt(item.gain_pct)}%</td></tr>`;
    }).join('');
    const hospital = state.optimization.Hospital || {};
    const fire = state.optimization['Fire station'] || {};
    return `
      <div class="page-card map-card"><h3>Candidate locations for further assessment</h3>${mapShell('optimizationMap', '<label><input type="checkbox" data-map-layer="hospitals" checked> Hospitals</label><label><input type="checkbox" data-map-layer="fire" checked> Fire stations</label><label><input type="checkbox" data-map-layer="clinics"> Clinics</label><label><input type="checkbox" data-map-layer="candidates" checked> Candidate locations</label>')}</div>
      <div class="page-card"><h3>Greedy maximal-coverage scenario · 5-minute standard</h3><div class="table-wrap optimization-summary-table-wrap"><table class="optimization-summary-table"><colgroup><col><col><col></colgroup><tr><th>Facility</th><th>Current ≤5 min</th><th>With candidates ≤5 min</th></tr>
        <tr><td>Hospital</td><td>${fmt(hospital.coverage_before_pct)}%</td><td>${fmt(hospital.coverage_after_pct)}%</td></tr>
        <tr><td>Fire station</td><td>${fmt(fire.coverage_before_pct)}%</td><td>${fmt(fire.coverage_after_pct)}%</td></tr></table></div>
        <div class="chart-wrap"><canvas id="optimizationChart"></canvas></div>
        <p class="data-note">Illustrative 5-minute coverage scenario using the same 4,000 sampled road nodes and rounded access times as Accessibility; not population-weighted. Candidate gains near the study-area edge may reflect boundary clipping. Small coverage gains at the previous 10-minute standard do not by themselves establish a need for new facilities. P-median optimization is not implemented.</p></div>
      <div class="page-card"><h3>Candidate locations for further assessment</h3><div class="table-wrap"><table><tr><th>Facility</th><th>Rank</th><th>Additional coverage (% of demand nodes)</th></tr>${rows || '<tr><td colspan="3">Candidate output is unavailable. Run pipeline phase 4.</td></tr>'}</table></div><p class="data-note">These points are selected from a seeded random sample of road nodes. They are candidate locations for further assessment, not site recommendations; verify land availability, road access, safety, and suitability before considering any site.</p></div>`;
  }

  function renderRecommendations() {
    const demand = features(loaded.demand);
    const priorities = demand.filter(feature => props(feature).priority === 'Very High');
    const priorityShare = demand.length ? priorities.length / demand.length * 100 : null;
    const candidates = features(loaded.recommended);
    const firstHospital = candidates.find(feature => props(feature).type === 'Hospital' && Number(props(feature).rank) === 1);
    const firstFire = candidates.find(feature => props(feature).type === 'Fire station' && Number(props(feature).rank) === 1);
    const hospitalCoordinates = firstHospital?.geometry?.coordinates;
    const fireCoordinates = firstFire?.geometry?.coordinates;
    const sameFirstNode = hospitalCoordinates && fireCoordinates
      && hospitalCoordinates.length >= 2 && fireCoordinates.length >= 2
      && hospitalCoordinates.every((coordinate, index) => Math.abs(coordinate - fireCoordinates[index]) < 1e-7);
    const next = candidates.slice(0, 4).map(feature => {
      const item = props(feature);
      const coordinate = feature.geometry?.coordinates || [];
      return `<tr><td>${esc(item.type)} #${esc(item.rank)}</td><td>${fmt(item.gain_pct)}%</td><td>${fmt(coordinate[1], 4)}, ${fmt(coordinate[0], 4)}</td></tr>`;
    }).join('');
    return `
      <div class="page-card recommendation-quartile-card"><h3>Slowest-quartile sample points</h3><div class="metric-big">${priorities.length}<small>${priorityShare === null ? 'share unavailable' : `${fmt(priorityShare)}% of ${demand.length.toLocaleString()} samples`}</small></div><p class="data-note">This is a relative quartile: about one quarter of sampled road nodes are always in the slowest group. It is not an absolute emergency-risk count or incident prediction.</p><h4 class="recommendation-chart-title">Nodes by slower-service travel time</h4><div class="chart-wrap"><canvas id="recommendationAccessChart" aria-label="Road-node counts in fixed bands of the slower of hospital or fire-station access times"></canvas></div></div>
      <div class="page-card recommendation-candidates"><h3>Candidate locations for further assessment</h3><div class="table-wrap"><table><colgroup><col style="width:25%"><col style="width:20%"><col style="width:55%"></colgroup><tr><th>Site</th><th>Gain</th><th>Latitude, longitude</th></tr>${next || '<tr><td colspan="3">No candidate output available.</td></tr>'}</table></div>${sameFirstNode ? '<p class="data-note">The same candidate node ranks first for both services.</p>' : ''}<p class="data-note">The shared first-ranked point is a road-network node inside the project boundary. Available data do not include land-use or waterbody checks, so open-field, river, parcel, and site suitability cannot be confirmed. These are candidates for assessment, not site recommendations.</p></div>
      <div class="page-card"><h3>Evidence-based next steps</h3><ul class="recommendation-list">
        <li><strong>Assess candidate locations, not recommendations.</strong> Phase 4 finds incremental road-node coverage gains; verify land availability and response operations before planning.</li>
        <li><strong>Review slowest-quartile access samples.</strong> Use the relative priority points for field validation; no named neighborhood or population impact is inferred.</li>
        <li><strong>Improve evidence before predictive deployment.</strong> Replace simulated incidents with approved dispatch/arrival records and add population and traffic data.</li>
      </ul><p class="data-note">All recommendations are planning hypotheses derived from available outputs; not dispatch instructions.</p></div>`;
  }

  function renderPriorityZones() {
    const demand = features(loaded.demand);
    const counts = ['Low', 'Moderate', 'High', 'Very High'].map(label => {
      const count = demand.filter(feature => props(feature).priority === label).length;
      const share = demand.length ? `${fmt(count / demand.length * 100)}%` : 'n/a';
      return `<tr><td>${label}</td><td>${count.toLocaleString()}</td><td>${share}</td></tr>`;
    }).join('');
    return `
      <div class="page-card map-card priority-map-card"><h3>500 m mean access-time zones</h3>
        ${mapShell('priorityMap', '<span>Cells aggregate sampled road-node travel times; hover a cell for service estimates.</span>')}
      </div>
      <div class="page-card"><h3>Relative priority classes</h3><div class="table-wrap"><table><tr><th>Class</th><th>Nodes</th><th>Share</th></tr>${counts}</table></div><p class="data-note">Quartiles are relative ranks of the slower available service time; about one quarter of nodes fall in each class. They are not absolute risk levels.</p></div>
      <div class="page-card"><h3>Nodes by slower-service time</h3><div class="chart-wrap"><canvas id="priorityAccessChart" aria-label="Road-node sample counts in fixed bands of mean slower-service travel time"></canvas></div><p class="data-note">Fixed time bands, counted over sampled road nodes using the slower available hospital/fire estimate.</p></div>
      <p class="data-note">Grid cells are 500 m squares with at least one sampled road node. Color shows the average slower-service travel time in each cell; these are planning summaries, not neighborhood boundaries, population zones, or validated risk predictions.</p>`;
  }

  function renderDispatch() {
    return `
      <div class="dispatch-banner">DEMO – simulation · No live emergency is being monitored and no unit will be dispatched.</div>
      <div class="dispatch-layout">
        <section class="page-card dispatch-controls"><h3>Scenario &amp; controls</h3>
          <label for="dispatchScenario" class="data-note">Incident scenario</label>
          <select id="dispatchScenario" class="dispatch-select"><option>Medical emergency</option><option>Fire incident</option><option>Road incident</option></select>
          <label for="dispatchSeverity" class="data-note">Illustrative severity</label>
          <select id="dispatchSeverity" class="dispatch-select"><option value="high">High — demo</option><option value="medium">Moderate — demo</option><option value="low">Low — demo</option></select>
          <button type="button" class="tool-button" id="dispatchRoute">Calculate nearest routes</button>
          <div id="dispatchOrigin" class="data-note">Click the map to set a simulated origin.</div>
          <p class="data-note warning">Routes and assignments are demonstrations only. No live incident feed, ambulance availability, clinical triage, or dispatch connection exists.</p>
        </section>
        <section class="page-card dispatch-map-card"><h3>Map &amp; route</h3>
          ${mapShell('dispatchMap', '<span>Click the map to set a scenario origin.</span>')}
          <div id="routeResults" class="route-results">Select a scenario origin, then calculate routes.</div>
        </section>
        <aside class="page-card dispatch-summary"><h3>Severity &amp; suggested facilities</h3>
          <div><strong id="dispatchSeverityLabel">High — demo</strong><div class="dispatch-severity"><span id="dispatchSeverityBar" data-level="high"></span></div></div>
          <div class="dispatch-eta"><span>Simulated ETA · road-network estimate</span><strong id="dispatchEta">ETA —</strong></div>
          <article id="dispatchHospitalCard" class="assignment-card">Suggested hospital will appear after route calculation.</article>
          <article id="dispatchFireCard" class="assignment-card">Suggested fire station will appear after route calculation.</article>
          <p class="data-note">Hospital candidates require “hospital” in the OSM name or a positive emergency tag; other healthcare records are treated as clinics. OSM classifications are not independently verified. Facility suggestions are not assignments, and ETA is a free-flow estimate, not a live arrival time.</p>
        </aside>
      </div>`;
  }

  function renderReports() {
    const simulatedLabel = state.stats.demo ? ' (simulated data)' : '';
    return `
      <div class="page-card"><h3>Incident records by type</h3><div class="chart-wrap"><canvas id="reportTypeChart"></canvas></div><p class="data-note">${state.stats.demo ? 'Simulated data; not verified incident statistics.' : 'Based on incident records in the project data.'}</p></div>
      <div class="page-card"><h3>Model diagnostic summary</h3><div class="table-wrap"><table><tr><th>Measure</th><th>Value</th></tr><tr><td>Incident records</td><td>${state.stats.n ?? 'n/a'}</td></tr><tr><td>Estimated response MAE${simulatedLabel}</td><td>${state.stats.mae == null ? 'n/a' : `${fmt(state.stats.mae, 2)} min`}</td></tr><tr><td>Squared correlation${simulatedLabel}</td><td>${state.stats.r2 ?? 'n/a'}</td></tr><tr><td>Facility counts</td><td>${features(loaded.hospitals).length} hospitals / ${features(loaded.fire).length} fire stations</td></tr></table></div></div>
      <div class="page-card"><h3>Download project results</h3><div class="control-row"><button class="tool-button" id="exportIncidents">Download incidents CSV</button><button class="tool-button" id="exportAccess">Download access points CSV</button><button class="tool-button" id="exportGeo">Download facilities GeoJSON</button><button class="tool-button" id="printReport">Print / Save PDF</button></div><p class="data-note">PDF uses the browser print dialog. CSV exports use the currently loaded project datasets.</p></div>
      <div class="page-card"><h3>Road nodes by slower-service travel time</h3><div class="chart-wrap"><canvas id="reportRiskChart" aria-label="Road-node sample counts in fixed bands of slower-service travel time"></canvas></div><p class="data-note">Fixed bands use the slower available hospital or fire-station estimate for each sampled road node.</p></div>
      <div class="page-card"><h3>Data sources and date</h3><p class="data-note"><strong>OpenStreetMap:</strong> Roads and facility data; the road graph file timestamp indicates 2026-11-08 (approximate download date; the facility extract has no separate timestamp). <strong>Study area:</strong> 8 km radius centered on Rawalpindi city centre (33.5973° N, 73.0479° E). <strong>Analysis environment:</strong> Python 3.12.10; OSMnx 2.1.1; NetworkX 3.7; GeoPandas 1.2.0; pandas 3.1.1; NumPy 2.5.4; scikit-learn 1.9.1.</p></div>
      <div class="page-card limitations-card"><h3>Limitations</h3>
        <p class="data-note">Interpret this dashboard as a local planning and analysis aid, not an operational emergency dispatch system.</p>
        <ul>
          <li><strong>Incident records:</strong> ${state.stats.demo ? 'The displayed incident set is simulated and is not verified Rescue 1122 or other official emergency history.' : 'Records are loaded from project data; their provenance and official verification are not established by this dashboard.'} Model diagnostics based on simulated records are not evidence of real-world accuracy.</li>
          <li><strong>Population exposure:</strong> ${loaded.populationMeta ? `WorldPop ${esc(loaded.populationMeta.year)} (${esc(loaded.populationMeta.release || 'modeled estimate')}) is available as a map overlay. It is an estimated people-per-cell surface, not census counts, and is not used in the displayed accessibility percentages, which describe sampled road-network nodes. <a href="${esc(loaded.populationMeta.source_url)}" target="_blank" rel="noopener noreferrer">Dataset metadata and citation</a>.` : 'No WorldPop or other population raster is integrated. Accessibility percentages describe sampled road-network nodes, not people or households.'}</li>
          <li><strong>Facilities:</strong> Hospital and emergency-service points come from community-mapped OpenStreetMap data. They have not been independently checked against an official hospital or fire-station register; mapped names, contact details, services, and operating status may be incomplete or outdated.</li>
          <li><strong>Geographic scope and coverage:</strong> Facility and network coverage results describe only the project's compact, approximately 8 km study area (the road network covers the surrounding square, about 16 km across) around Rawalpindi city centre. Near-100% road-node coverage within this boundary does not mean all of Rawalpindi city or district is covered, and the percentages are not population-weighted. Route estimates near the study-area boundary are less reliable because the available road graph is clipped to the project boundary and may omit useful roads or connections beyond it.</li>
          <li><strong>Travel estimates:</strong> Routes and travel times use the available OpenStreetMap drive graph and free-flow assumptions. Live traffic, closures, emergency vehicle restrictions, dispatch delays, facility capacity, and current unit availability are not connected.</li>
          <li><strong>Facility optimization:</strong> The scenario uses a 5-minute threshold, equal-weight sampled road nodes, and candidate nodes drawn from a seeded random sample of the road graph. Locations near the edge of the approximately 8 km study area may reflect boundary clipping because facilities and roads just outside the study area are not counted. Candidate locations are for further assessment, not site recommendations; verify land availability, road access, and suitability. Population weighting and p-median optimization are not implemented.</li>
          <li><strong>Analysis and recommendations:</strong> Access classes and site-planning outputs are transparent network-based scenarios, not validated AI predictions, population-weighted findings, or operational instructions.</li>
        </ul>
      </div>`;
  }

  function chart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas || typeof Chart === 'undefined') return;
    const instance = new Chart(canvas, config);
    chartRefs.push(instance);
    window.requestAnimationFrame(() => {
      if (instance.canvas?.isConnected) instance.resize();
    });
  }

  function updateNetworkServiceStatus(minutes) {
    const shownAreas = [
      document.querySelector('[data-map-layer="serviceHosp"]')?.checked ? 'hospital (blue)' : '',
      document.querySelector('[data-map-layer="serviceFire"]')?.checked ? 'fire-station (red)' : ''
    ].filter(Boolean);
    const status = document.getElementById('serviceAreaStatus');
    if (!status) return;
    status.textContent = shownAreas.length
      ? `${minutes}-minute ${shownAreas.join(' and ')} service area${shownAreas.length > 1 ? 's' : ''} shown. Coverage is for sampled road nodes, not population.`
      : `No ${minutes}-minute service areas are shown. Coverage is for sampled road nodes, not population.`;
  }

  const chartOptions = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#cfe4ff', boxWidth: 10 } } },
    scales: {
      x: { ticks: { color: '#9ab4cf' }, grid: { display: false } },
      y: { beginAtZero: true, ticks: { color: '#9ab4cf' }, grid: { color: 'rgba(255,255,255,0.06)' } }
    }
  };

  function drawCoverageChart(id, { startAtZero = false } = {}) {
    const thresholds = [5, 10, 15, 20, 30];
    const hospital = values('hosp_min'), fire = values('fire_min');
    chart(id, { type: 'bar', data: { labels: thresholds.map(value => `${value} min`), datasets: [
      { label: 'Hospital nodes covered (%)', data: thresholds.map(limit => hospital.length ? hospital.filter(value => value <= limit).length / hospital.length * 100 : 0), backgroundColor: '#4da3ff' },
      { label: 'Fire station nodes covered (%)', data: thresholds.map(limit => fire.length ? fire.filter(value => value <= limit).length / fire.length * 100 : 0), backgroundColor: '#f0524a' }
    ] }, options: {
      ...chartOptions,
      scales: {
        ...chartOptions.scales,
        y: {
          ...chartOptions.scales.y,
            ...(startAtZero ? {} : { min: 40 }),
            max: 100,
          title: { display: true, text: '% of road nodes covered', color: '#9ab4cf' },
          ticks: { color: '#9ab4cf', callback: value => `${value}%` }
        }
      }
    } });
  }

  function shareAboveThreshold(key, threshold) {
    const samples = values(key);
    return samples.length ? samples.filter(value => value > threshold).length / samples.length * 100 : null;
  }

  function drawAccessibilitySamples(map, key) {
    if (mapRefs.accessibilitySamples && map.hasLayer(mapRefs.accessibilitySamples)) {
      map.removeLayer(mapRefs.accessibilitySamples);
    }
    const colorForTime = minutes => minutes <= 5 ? '#2dd4bf'
      : minutes <= 10 ? '#facc15'
        : minutes <= 15 ? '#f59e0b' : '#f0524a';
    const validFeatures = features(loaded.demand).filter(feature => {
      const value = props(feature)[key];
      return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
    });
    mapRefs.accessibilitySamples = L.geoJSON({
      type: 'FeatureCollection',
      features: validFeatures
    }, {
      interactive: false,
      pointToLayer: (feature, latlng) => {
        const minutes = Number(props(feature)[key]);
        const color = colorForTime(minutes);
        return L.circleMarker(latlng, {
          radius: 2,
          stroke: false,
          fillColor: color,
          fillOpacity: 0.55,
          interactive: false
        });
      }
    }).addTo(map);
  }

  function histogramData(input) {
    const limits = [0, 5, 10, 15, 20, 30, Infinity];
    const labels = ['0–5', '5–10', '10–15', '15–20', '20–30', '30+'];
    const counts = limits.slice(0, -1).map((low, index) => input.filter(value => value >= low && value < limits[index + 1]).length);
    return { labels, counts };
  }

  function drawHistogram(id, key, label, color) {
    const bins = histogramData(values(key));
    chart(id, { type: 'bar', data: { labels: bins.labels, datasets: [{ label, data: bins.counts, backgroundColor: color }] }, options: {
      ...chartOptions,
      scales: {
        ...chartOptions.scales,
        x: {
          ...chartOptions.scales.x,
          title: { display: true, text: 'Travel time (minutes)', color: '#9ab4cf' }
        },
        y: {
          ...chartOptions.scales.y,
          title: { display: true, text: 'Road-node count', color: '#9ab4cf' }
        }
      }
    } });
  }

  function drawRiskChart(id) {
    const counts = ['Low', 'Moderate', 'High', 'Very High'].map(label => features(loaded.demand).filter(feature => props(feature).priority === label).length);
    chart(id, { type: 'doughnut', data: { labels: ['Low', 'Moderate', 'High', 'Very High'], datasets: [{ data: counts, backgroundColor: ['#2dd4bf', '#facc15', '#f59e0b', '#f0524a'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: chartOptions.plugins } });
  }

  function drawRecommendationAccessChart(id) {
    const bands = [
      { label: '≤5 min', color: '#2dd4bf', matches: minutes => minutes <= 5 },
      { label: '5–10 min', color: '#facc15', matches: minutes => minutes > 5 && minutes <= 10 },
      { label: '10–15 min', color: '#f59e0b', matches: minutes => minutes > 10 && minutes <= 15 },
      { label: '>15 min', color: '#f0524a', matches: minutes => minutes > 15 }
    ];
    const accessTimes = features(loaded.demand).flatMap(feature => {
      const available = ['hosp_min', 'fire_min']
        .map(key => Number(props(feature)[key]))
        .filter(Number.isFinite);
      return available.length ? [Math.max(...available)] : [];
    });
    const counts = bands.map(band => accessTimes.filter(band.matches).length);
    chart(id, {
      type: 'doughnut',
      data: { labels: bands.map(band => band.label), datasets: [{ data: counts, backgroundColor: bands.map(band => band.color) }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          ...chartOptions.plugins,
          tooltip: {
            callbacks: {
              label: context => {
                const count = Number(context.raw) || 0;
                const percent = accessTimes.length ? count / accessTimes.length * 100 : 0;
                return `${context.label}: ${count.toLocaleString()} nodes (${fmt(percent)}%)`;
              }
            }
          }
        }
      }
    });
  }

  function drawIncidentTypes(id) {
    const counts = state.stats.by_type || {};
    chart(id, { type: 'bar', data: { labels: Object.keys(counts), datasets: [{ label: 'Incident records', data: Object.values(counts), backgroundColor: '#f59e0b' }] }, options: chartOptions });
  }

  function drawResponsePairs(id) {
    const pairs = state.stats.pairs || [];
    chart(id, {
      type: 'scatter',
      data: { datasets: [
        { label: 'Records', data: pairs.map(pair => ({ x: pair[0], y: pair[1] })), backgroundColor: '#4da3ff', pointRadius: 3 },
        { label: 'Equal estimate and actual', type: 'line', data: [[0, 0], [25, 25]], borderColor: '#f0524a', pointRadius: 0 }
      ] },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          legend: { ...chartOptions.plugins.legend, position: 'bottom', labels: { ...chartOptions.plugins.legend.labels, padding: 12 } }
        },
        scales: {
          x: {
            title: { display: true, text: 'Network estimate (min)', color: '#9ab4cf' },
            ticks: { color: '#9ab4cf' },
            grid: { color: 'rgba(255,255,255,0.06)' }
          },
          y: {
            title: { display: true, text: 'Actual time (min)', color: '#9ab4cf' },
            ticks: { color: '#9ab4cf' },
            grid: { color: 'rgba(255,255,255,0.06)' }
          }
        }
      }
    });
  }

  function drawForecast(id) {
    const forecast = state.stats.forecast || [];
    const labels = forecast.map(item => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(item.date));
      if (!match) return item.date;
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date);
    });
    chart(id, { type: 'line', data: { labels, datasets: [{ label: 'Expected records / day', data: forecast.map(item => item.expected), borderColor: '#2dd4bf', backgroundColor: 'rgba(45,212,191,0.12)', fill: true, tension: 0.25 }] }, options: chartOptions });
  }

  function popupOptions(map, requestedMaxWidth = 360) {
    return {
      maxWidth: Math.max(160, Math.min(requestedMaxWidth, map.getSize().x - 80)),
      maxHeight: 300, autoPan: true, keepInView: true, autoPanPadding: [24, 24]
    };
  }

  function addFeatureLayer(map, name, geo, style, marker = false) {
    if (!features(geo).length) return;
    mapRefs[name] = L.geoJSON(geo, {
      interactive: name !== 'serviceHosp' && name !== 'serviceFire',
      pointToLayer: marker ? (feature, latlng) => {
        if (name === 'hospitals' || name === 'fire' || name === 'clinics') {
          const hospital = name === 'hospitals' && isEmergencyHospital(feature);
          const fireStation = name === 'fire';
          const icon = L.divIcon({
            className: `facility-map-icon ${hospital ? 'hospital-map-icon' : fireStation ? 'fire-map-icon' : 'clinic-map-icon'}`,
            html: `<span>${hospital ? 'H' : fireStation ? 'F' : 'C'}</span>`,
            iconSize: [25, 25],
            iconAnchor: [12, 23],
            popupAnchor: [0, -21]
          });
          const type = hospital ? 'Hospital' : fireStation ? 'Fire station' : 'Clinic';
          return L.marker(latlng, { icon, title: facilityName(feature) || type, alt: facilityName(feature) });
        }
        return L.circleMarker(latlng, typeof style === 'function' ? style(feature) : style);
      } : undefined,
      style: marker ? undefined : style,
      onEachFeature: (feature, layer) => {
        const item = props(feature);
        if (name === 'priorityZones') {
          const minutes = value => value == null ? NaN : Number(value);
          const hospital = minutes(item.hospital_mean_min);
          const fire = minutes(item.fire_mean_min);
          const slow = minutes(item.slow_mean_min);
          const lines = [
            `${Number(item.sample_count) || 0} sampled road node${Number(item.sample_count) === 1 ? '' : 's'}`,
            `Hospital mean: ${Number.isFinite(hospital) ? `${fmt(hospital)} min` : 'unavailable'}`,
            `Fire-station mean: ${Number.isFinite(fire) ? `${fmt(fire)} min` : 'unavailable'}`,
            `Slower-service mean: ${Number.isFinite(slow) ? `${fmt(slow)} min` : 'unavailable'}`
          ];
          layer.bindTooltip(lines.map(esc).join('<br>'), {
            sticky: true,
            direction: 'top',
            className: 'priority-zone-tooltip'
          });
          return;
        }
        if (name === 'hospitals' || name === 'fire' || name === 'clinics') {
          const facilityLayer = name === 'clinics' ? 'hospitals' : name;
          const index = name === 'clinics' ? -1 : facilityIndex(feature, facilityLayer);
          layer.bindPopup(facilityPopup(feature, facilityLayer, index), popupOptions(map));
          const label = facilityName(feature);
          if (map.getContainer().id !== 'overviewMap') {
            layer.bindTooltip(label, { direction: 'top', offset: [0, -6] });
          }
          return;
        }
        const title = item.name || item.type || item.priority || item.highway || 'Map feature';
        const extra = item.minutes !== undefined ? `<br>${esc(item.minutes)} minute service area`
          : item.priority ? `<br>${esc(item.priority)} access priority`
            : item.highway ? `<br>${esc(item.highway)} road` : '';
        layer.bindPopup(`<strong>${esc(title)}</strong>${extra}`, popupOptions(map, 320));
      }
    });
  }

  function drawNetworkServiceAreas(map, minutes) {
    ['serviceHosp', 'serviceFire'].forEach(key => {
      const visible = Boolean(mapRefs[key] && map.hasLayer(mapRefs[key]));
      if (visible) map.removeLayer(mapRefs[key]);
      const source = key === 'serviceHosp' ? loaded.serviceHospitals : loaded.serviceFire;
      const geo = {
        type: 'FeatureCollection',
        features: features(source).filter(feature => Number(props(feature).minutes) === minutes)
      };
      if (!geo.features.length) {
        delete mapRefs[key];
        return;
      }
      const hospital = key === 'serviceHosp';
      const color = hospital ? '#4da3ff' : '#f0524a';
      mapRefs[key] = L.geoJSON(geo, {
        interactive: false,
        style: {
          color,
          weight: 1.5,
          opacity: 0.95,
          fillColor: color,
          fillOpacity: 0.07
        }
      });
      if (visible) mapRefs[key].addTo(map);
    });
    ['hospitals', 'fire', 'clinics'].forEach(key => {
      if (map.hasLayer(mapRefs[key])) mapRefs[key].bringToFront();
    });
  }

  function createLocalityLayer(map) {
    const zoom = map.getZoom();
    const visiblePlaces = zoom >= 14
      ? new Set(['suburb', 'locality', 'neighbourhood', 'quarter', 'city_district'])
      : zoom >= 13 ? new Set(['suburb', 'locality', 'city_district'])
        : new Set(['suburb', 'city_district']);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) context.font = '600 11px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif';
    const priority = { neighbourhood: 3, quarter: 3, locality: 2, city_district: 2, suburb: 1 };
    const occupied = [];
    const visibleFeatures = features(loaded.localities).map(feature => {
      const item = props(feature);
      const coordinates = feature.geometry?.coordinates;
      const name = facilityName(feature);
      if (!name || !visiblePlaces.has(item.place) || !coordinates || coordinates.length < 2) return null;
      const latlng = L.latLng(coordinates[1], coordinates[0]);
      if (!map.getBounds().contains(latlng)) return null;
      const point = map.latLngToContainerPoint(latlng);
      const width = Math.ceil(context ? context.measureText(name).width : name.length * 6) + 12;
      return {
        feature,
        latlng,
        name,
        priority: priority[item.place] || 0,
        bounds: { left: point.x - width / 2 - 3, right: point.x + width / 2 + 3, top: point.y - 11, bottom: point.y + 11 }
      };
    }).filter(Boolean).sort((first, second) =>
      second.priority - first.priority || first.name.localeCompare(second.name)
    ).filter(candidate => {
      const overlaps = occupied.some(box =>
        candidate.bounds.left < box.right && candidate.bounds.right > box.left
        && candidate.bounds.top < box.bottom && candidate.bounds.bottom > box.top
      );
      if (!overlaps) occupied.push(candidate.bounds);
      return !overlaps;
    });
    const geo = {
      type: 'FeatureCollection',
      features: visibleFeatures.map(item => item.feature)
    };
    return L.geoJSON(geo, {
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        radius: 0, opacity: 0, fillOpacity: 0, interactive: false
      }),
      onEachFeature: (feature, layer) => layer.bindTooltip(
        esc(facilityName(feature)),
        { permanent: true, direction: 'center', className: 'locality-map-tooltip', interactive: false }
      )
    });
  }

  function facilityIndex(feature, layerName) {
    if (!facilityName(feature) || (layerName === 'fire' && props(feature).amenity !== 'fire_station')) return -1;
    const source = features(loaded[layerName]);
    const [lon, lat] = feature.geometry.coordinates;
    return source.findIndex(candidate => {
      const position = candidate.geometry?.coordinates;
      return position && Math.abs(position[0] - lon) < 1e-8 && Math.abs(position[1] - lat) < 1e-8;
    });
  }

  function facilityPopup(feature, layerName, index = facilityIndex(feature, layerName)) {
    const item = props(feature);
    const name = facilityName(feature);
    const address = item['addr:full'] || [
      item['addr:housenumber'], item['addr:street'], item['addr:suburb'],
      item['addr:city'], item['addr:postcode']
    ].filter(Boolean).join(', ') || 'Address not tagged in OpenStreetMap';
    const phone = item['contact:phone'] || item.phone || item.mobile || item['contact:mobile'];
    const email = item['contact:email'] || item.email;
    const website = item['contact:website'] || item.website;
    const type = layerName === 'hospitals' ? (isEmergencyHospital(feature) ? 'Hospital' : 'Clinic')
      : item.healthcare || item.amenity || item.emergency;
    const services = item['healthcare:speciality'] || item['healthcare:specialty'] || item.service;
    const [lon, lat] = feature.geometry.coordinates;
    const distance = currentLocation
      ? `<div><span class="popup-label">Straight-line distance:</span> ${distanceKm(currentLocation, { lat, lon }).toFixed(2)} km</div>`
      : '';
    const fields = [
      ['Type', type], ['Address', address], ['Phone', phone], ['Email', email],
      ['Website', website], ['Services / specialty', services],
      ['Opening hours', item.opening_hours], ['Operator', item.operator],
      ['Beds', item.beds], ['Wheelchair access', item.wheelchair]
    ].filter(([, value]) => value);
    const details = fields.map(([label, value]) => `<div><span class="popup-label">${esc(label)}:</span> ${esc(value)}</div>`).join('');
    const otherTags = Object.entries(item)
      .filter(([key, value]) => ![
        'name', 'name:en', 'name:ur', 'amenity', 'healthcare', 'emergency',
        'addr:full', 'addr:housenumber', 'addr:street', 'addr:suburb',
        'addr:city', 'addr:postcode', 'contact:phone', 'phone', 'mobile',
        'contact:mobile', 'contact:email', 'email', 'contact:website',
        'website', 'healthcare:speciality', 'healthcare:specialty', 'service',
        'opening_hours', 'operator', 'beds', 'wheelchair', 'data_source',
        'osmid', 'element_type', 'id', 'element', 'type'
      ].includes(key) && value !== null && value !== undefined && String(value).trim())
      .map(([key, value]) => `<div><span class="popup-label">${esc(key)}:</span> ${esc(value)}</div>`).join('');
    const osmLink = item.osmid && item.element_type
      ? `<div><a target="_blank" rel="noopener noreferrer" href="https://www.openstreetmap.org/${encodeURIComponent(item.element_type)}/${encodeURIComponent(item.osmid)}">OpenStreetMap record</a></div>`
      : '';
    const navigate = index >= 0
      ? `<div><button type="button" class="tool-button" data-route-kind="${layerName === 'fire' ? 'fire' : 'hospital'}" data-route-index="${index}">Navigate to this facility</button></div>`
      : '';
    return `<strong>${esc(name)}</strong><div class="hospital-popup-details">${distance}${details || '<div>Additional details are not tagged in OpenStreetMap.</div>'}${otherTags}${osmLink}${navigate}</div>`;
  }

  function bindFacilityLabels(map) {
    const input = document.querySelector('[data-facility-labels]');
    if (!input) return;
    input.addEventListener('change', () => ['hospitals', 'fire'].forEach(name => {
      mapRefs[name]?.eachLayer(layer => {
        if (input.checked) layer.openTooltip();
        else layer.closeTooltip();
      });
    }));
  }

  function resetLayers(map, includeService = true) {
    Object.keys(mapRefs).forEach(key => { if (map.hasLayer(mapRefs[key])) map.removeLayer(mapRefs[key]); });
    mapClickHandler?.map.off('click', mapClickHandler.callback);
    mapClickHandler = null;
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  }

  function setupMap(elementId, { initialLayers = ['hospitals', 'fire'], clickRoutes = false } = {}) {
    const element = document.getElementById(elementId);
    if (!element || typeof L === 'undefined') return null;
    if (state.map && state.map._container === element) {
      state.map.invalidateSize();
      return state.map;
    }
    const map = L.map(elementId, { zoomControl: true }).setView([33.5973, 73.0479], 12);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Sources: Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS User Community', maxZoom: 16
    }).addTo(map);
    if (elementId === 'overviewMap') {
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Place names &amp; boundaries &copy; Esri', maxZoom: 16, pane: 'overlayPane'
      }).addTo(map);
    }
    const accessTimes = features(loaded.demand).map(feature =>
      Math.max(Number(props(feature).hosp_min) || 0, Number(props(feature).fire_min) || 0)
    ).filter(Number.isFinite);
    const minimumAccess = accessTimes.length ? Math.min(...accessTimes) : 0;
    const maximumAccess = accessTimes.length ? Math.max(...accessTimes) : 1;
    addFeatureLayer(map, 'boundary', loaded.boundary, { color: '#2dd4bf', weight: 1.5, fillOpacity: 0.015 });
    addFeatureLayer(map, 'roads', loaded.roads, feature => {
      const roadClass = String(props(feature).highway || '');
      const major = /motorway|trunk|primary/.test(roadClass);
      return { color: major ? '#f59e0b' : '#38bdf8', weight: major ? 2 : 1, opacity: major ? 0.85 : 0.62 };
    });
    addFeatureLayer(map, 'hospitals', {
      type: 'FeatureCollection',
      features: features(loaded.hospitals).filter(feature =>
        facilityName(feature)
          && (!['dispatchMap', 'networkMap', 'optimizationMap'].includes(elementId) || isEmergencyHospital(feature))
      )
    }, { radius: 5, color: '#4da3ff', fillColor: '#4da3ff', fillOpacity: 0.9, weight: 1 }, true);
    if (elementId === 'networkMap' || elementId === 'optimizationMap') {
      addFeatureLayer(map, 'clinics', {
        type: 'FeatureCollection',
        features: features(loaded.hospitals).filter(feature => facilityName(feature) && !isEmergencyHospital(feature))
      }, { radius: 5, color: '#778899', fillColor: '#778899', fillOpacity: 0.9, weight: 1 }, true);
    }
    addFeatureLayer(map, 'fire', {
      type: 'FeatureCollection', features: features(loaded.fire)
        .filter(feature => facilityName(feature) && props(feature).amenity === 'fire_station')
    }, { radius: 6, color: '#f0524a', fillColor: '#f0524a', fillOpacity: 0.95, weight: 1 }, true);
    addFeatureLayer(map, 'demand', loaded.demand, feature => {
      const access = Math.max(Number(props(feature).hosp_min) || 0, Number(props(feature).fire_min) || 0);
      const color = heatColor(access, minimumAccess, maximumAccess);
      return { radius: 3, color, fillColor: color, fillOpacity: 0.65, weight: 0 };
    }, true);
    addFeatureLayer(map, 'priorityZones', loaded.priorityZones, feature => {
      const minutes = Number(props(feature).slow_mean_min);
      const color = !Number.isFinite(minutes) ? '#8492a6'
        : minutes <= 5 ? '#2dd4bf'
          : minutes <= 10 ? '#facc15'
            : minutes <= 15 ? '#f59e0b' : '#f0524a';
      return { color, weight: 1, opacity: 0.85, fillColor: color, fillOpacity: 0.58 };
    });
    if (loaded.populationMeta?.bounds && loaded.populationMeta.image) {
      mapRefs.population = L.imageOverlay(
        `data/${encodeURIComponent(loaded.populationMeta.image)}`,
        loaded.populationMeta.bounds,
        { opacity: 0.72, alt: `WorldPop ${loaded.populationMeta.year} estimated population per grid cell` }
      );
    }
    mapRefs.incidents = L.geoJSON(loaded.incidents, {
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 4, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.6, weight: 1 }),
      onEachFeature: (feature, layer) => layer.bindPopup(
        `<strong>${esc(props(feature).type || 'Incident')}</strong><br>Estimated access: ${fmt(props(feature).est)} min${state.stats.demo ? '<br>SIMULATED' : ''}`,
        popupOptions(map, 320)
      )
    });
    const heatGradient = { 0.2: '#3b82f6', 0.45: '#2dd4bf', 0.65: '#facc15', 0.85: '#f59e0b', 1: '#f0524a' };
    if (typeof L.heatLayer === 'function') {
      const heatPoints = geo => features(geo).flatMap(feature => {
        const coordinates = feature.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
        const lon = Number(coordinates[0]);
        const lat = Number(coordinates[1]);
        return Number.isFinite(lat) && Number.isFinite(lon) ? [[lat, lon]] : [];
      });
      mapRefs.incidentsHeat = L.heatLayer(
        heatPoints(loaded.incidents).map(([lat, lon]) => [lat, lon, 1]),
        { radius: 20, blur: 22, gradient: heatGradient }
      );
      const demandPoints = features(loaded.demand).flatMap(feature => {
        const coordinates = feature.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
        const lon = Number(coordinates[0]);
        const lat = Number(coordinates[1]);
        const score = Number(props(feature).score);
        return Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(score)
          ? [[lat, lon, score]] : [];
      });
      const maxScore = Math.max(1, ...demandPoints.map(([, , score]) => score));
      mapRefs.demandHeat = L.heatLayer(
        demandPoints.map(([lat, lon, score]) => [lat, lon, Math.max(0, score) / maxScore]),
        { radius: 22, blur: 25, gradient: heatGradient }
      );
    }
    addFeatureLayer(map, 'serviceHosp', { type: 'FeatureCollection', features: features(loaded.serviceHospitals).filter(feature => Number(props(feature).minutes) === 10) }, { color: '#4da3ff', weight: 1.5, opacity: 0.95, fillColor: '#4da3ff', fillOpacity: 0.07 });
    addFeatureLayer(map, 'serviceFire', { type: 'FeatureCollection', features: features(loaded.serviceFire).filter(feature => Number(props(feature).minutes) === 10) }, { color: '#f0524a', weight: 1.5, opacity: 0.95, fillColor: '#f0524a', fillOpacity: 0.07 });
    addFeatureLayer(map, 'candidates', loaded.recommended, () => {
      return { radius: 9, color: '#fff', fillColor: '#f59e0b', fillOpacity: 1, weight: 2.5 };
    }, true);
    resetLayers(map, false);
    if (elementId === 'overviewMap') {
      let localityLayer = createLocalityLayer(map);
      mapRefs.localities = localityLayer;
      map.on('moveend', () => {
        const enabled = map.hasLayer(localityLayer);
        if (enabled) map.removeLayer(localityLayer);
        localityLayer = createLocalityLayer(map);
        mapRefs.localities = localityLayer;
        if (enabled) localityLayer.addTo(map);
      });
    }
    initialLayers.forEach(name => mapRefs[name]?.addTo(map));
    if (elementId === 'priorityMap' && mapRefs.priorityZones?.getBounds().isValid()) {
      map.fitBounds(mapRefs.priorityZones.getBounds(), { padding: [18, 18], maxZoom: 13 });
    }
    if (elementId === 'overviewMap') addOverviewMapControls(map);
    state.map = map;
    window.requestAnimationFrame(() => {
      if (map.getContainer()?.isConnected) map.invalidateSize();
    });

    if (clickRoutes) {
      const callback = event => requestRoutes(event.latlng, map);
      map.on('click', callback);
      mapClickHandler = { map, callback };
    }
    return map;
  }

  function addOverviewMapControls(map) {
    const control = L.control({ position: 'topright' });
    control.onAdd = () => {
      const container = L.DomUtil.create('div', 'overview-map-controls leaflet-control');
      container.innerHTML = [
        ['boundary', 'Study boundary', true],
        ['localities', 'Area names', true],
        ['hospitals', 'Hospitals', true],
        ['fire', 'Fire stations', true],
        ['roads', 'Road network', false],
        ['demand', 'Access samples', false]
      ].map(([layer, label, checked]) => `<label><input type="checkbox" data-map-layer="${layer}"${checked ? ' checked' : ''}>${label}</label>`).join('');
      L.DomEvent.disableClickPropagation(container);
      container.querySelectorAll('[data-map-layer]').forEach(input => {
        input.addEventListener('change', () => {
          const layer = mapRefs[input.dataset.mapLayer];
          if (!layer) return;
          if (input.checked) layer.addTo(map);
          else map.removeLayer(layer);
        });
      });
      return container;
    };
    control.addTo(map);
  }

  async function requestRoutes(origin, map) {
    const result = document.getElementById('routeResults');
    if (result) result.textContent = 'Calculating routes on the existing road network…';
    try {
      const usesNearbyService = state.activePage === 'Dispatch Center' || state.activePage === 'Network Analysis';
      const endpoint = usesNearbyService ? '/api/nearby' : '/api/dispatch';
      const response = await fetch(`${endpoint}?lat=${encodeURIComponent(origin.lat)}&lon=${encodeURIComponent(origin.lng)}`);
      if (!response.ok) throw new Error(`Route API returned HTTP ${response.status}`);
      const responseRoutes = await response.json();
      let routes = responseRoutes;
      let nearby = null;
      if (usesNearbyService) {
        const catalog = facilityCatalog();
        const eligibleHospitals = new Set(catalog
          .filter(item => item.kind === 'hospital' && isEmergencyHospital(item.feature))
          .map(item => item.index));
        const fireFacilityIndexes = new Set(catalog
          .filter(item => item.kind === 'fire')
          .map(item => item.index));
        const nearest = {
          hospital: (responseRoutes.hospital || []).filter(entry => eligibleHospitals.has(entry.index)).slice(0, 3),
          fire: (responseRoutes.fire || []).filter(entry =>
            fireFacilityIndexes.has(entry.index)
          ).slice(0, 3)
        };
        routes = {
          hospital: nearest.hospital[0] || null,
          fire: nearest.fire[0] || null
        };
        if (state.activePage === 'Dispatch Center') {
          nearby = nearest;
          currentLocation = { lat: origin.lat, lon: origin.lng };
          showDispatchNearbyFacilities(map, nearby);
        }
      }
      if (routeLayer) map.removeLayer(routeLayer);
      routeLayer = L.layerGroup().addTo(map);
      const lineOptions = [['hospital', '#4da3ff'], ['fire', '#f0524a']];
      const summaries = [];
      lineOptions.forEach(([key, color]) => {
        const route = routes[key];
        if (!route) {
          summaries.push(`<div class="route-card"><strong>${key === 'fire' ? 'Fire station' : 'Hospital'}</strong><br>No road route found.</div>`);
          return;
        }
        L.polyline(route.line, { color, weight: 4, opacity: 0.9 }).addTo(routeLayer);
        if (state.activePage !== 'Dispatch Center') {
          L.circleMarker(route.facility_ll, { radius: 7, color: '#fff', fillColor: color, fillOpacity: 1 }).addTo(routeLayer);
        }
        const nearestBy = 'travel time';
        summaries.push(`<div class="route-card"><strong>Nearest ${key === 'fire' ? 'fire station' : 'hospital'} by ${nearestBy}</strong><br>${esc(route.facility)} · ${fmt(route.minutes)} min</div>`);
      });
      L.circleMarker(origin, { radius: 7, color: '#fff', fillColor: '#f59e0b', fillOpacity: 1 }).addTo(routeLayer);
      if (result) result.innerHTML = summaries.join('');
      if (state.activePage === 'Dispatch Center') {
        updateDispatchFacilityCards(routes, nearby);
        if (routes.hospital?.line?.length) animateDispatchUnit(map, routes.hospital.line);
      }
    } catch (error) {
      if (result) result.textContent = `Route calculation failed: ${error.message}. Check that the existing server exposes the required route API.`;
      if (state.activePage === 'Dispatch Center') {
        document.getElementById('dispatchEta').textContent = 'Unavailable';
        document.getElementById('dispatchHospitalCard').textContent = 'No route suggestion is available.';
        document.getElementById('dispatchFireCard').textContent = 'No route suggestion is available.';
      }
      console.error('Route calculation failed', error);
    }
  }

  function updateDispatchFacilityCards(routes, nearby) {
    const hospital = routes.hospital;
    const fire = routes.fire;
    const minutes = Number(hospital?.minutes);
    const options = kind => (nearby?.[kind] || []).map((entry, index) =>
      `<li>${index + 1}. ${esc(entry.facility)} · ${fmt(entry.distance_km, 2)} km</li>`
    ).join('');
    document.getElementById('dispatchEta').textContent = hospital && Number.isFinite(minutes)
      ? `ETA ${Math.max(1, Math.ceil(minutes))} min` : 'Unavailable';
    document.getElementById('dispatchHospitalCard').innerHTML = hospital
      ? `<strong>Nearest eligible hospital · suggested only</strong><br>${esc(hospital.facility)}<br>Free-flow estimate: ${fmt(hospital.minutes)} min${options('hospital') ? `<details><summary>Nearest 3 hospitals on map</summary><ol>${options('hospital')}</ol></details>` : ''}`
      : 'No hospital route found.';
    document.getElementById('dispatchFireCard').innerHTML = fire
      ? `<strong>Nearest fire station · suggested only</strong><br>${esc(fire.facility)}<br>Free-flow estimate: ${fmt(fire.minutes)} min${options('fire') ? `<details><summary>Nearest 3 fire stations on map</summary><ol>${options('fire')}</ol></details>` : ''}`
      : 'No fire-station route found.';
  }

  function animateDispatchUnit(map, coordinates) {
    if (dispatchAnimationFrame !== null) window.cancelAnimationFrame(dispatchAnimationFrame);
    if (dispatchUnitMarker) map.removeLayer(dispatchUnitMarker);
    const path = coordinates.filter(point => Array.isArray(point) && point.length >= 2);
    if (path.length < 2) return;
    dispatchUnitMarker = L.marker(path[0], {
      icon: L.divIcon({ className: '', html: '<span class="dispatch-unit-marker">U</span>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      title: 'Simulated unit moving along suggested route'
    }).addTo(map);
    const started = performance.now();
    const duration = 12000;
    const move = now => {
      const progress = Math.min((now - started) / duration, 1);
      const segmentPosition = progress * (path.length - 1);
      const segment = Math.min(Math.floor(segmentPosition), path.length - 2);
      const fraction = segmentPosition - segment;
      const start = path[segment], end = path[segment + 1];
      dispatchUnitMarker.setLatLng([
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction
      ]);
      if (progress < 1) dispatchAnimationFrame = window.requestAnimationFrame(move);
      else dispatchAnimationFrame = null;
    };
    dispatchAnimationFrame = window.requestAnimationFrame(move);
  }

  function bindLayerInputs(map) {
    document.querySelectorAll('[data-map-layer]').forEach(input => {
      const names = input.dataset.mapLayer === 'service' ? ['serviceHosp', 'serviceFire']
        : input.dataset.mapLayer === 'candidates' ? ['candidates']
          : [input.dataset.mapLayer];
      input.addEventListener('change', () => names.forEach(name => {
        const layer = mapRefs[name];
        if (!layer) return;
        if (input.checked) layer.addTo(map);
        else map.removeLayer(layer);
      }));
      if (input.dataset.mapLayer === 'serviceHosp' || input.dataset.mapLayer === 'serviceFire') {
        input.addEventListener('change', () => {
          const selected = Number(document.querySelector('[data-service-minutes].selected')?.dataset.serviceMinutes || 10);
          updateNetworkServiceStatus(selected);
        });
      }
      if (input.dataset.mapLayer !== 'service' && input.dataset.mapLayer !== 'candidates') {
        const layer = mapRefs[input.dataset.mapLayer];
        if (layer && input.checked) layer.addTo(map);
      } else if (input.checked) names.forEach(name => mapRefs[name]?.addTo(map));
    });
  }

  function bindFacilitySearch(map) {
    const search = document.getElementById('facilitySearch');
    const button = document.getElementById('searchFacility');
    const routeButton = document.getElementById('routeSelectedFacility');
    const locationButton = document.getElementById('useCurrentLocation');
    const nearbyButton = document.getElementById('findNearbyServices');
    const recalculateButton = document.getElementById('recalculateFacilityRoute');
    const result = document.getElementById('searchResult');
    if (!search || !button || !routeButton || !locationButton || !nearbyButton || !recalculateButton || !result) return;
    const facilities = facilityCatalog();
    let locationMarker = null;
    let latestNearby = null;
    let hasInitialLocation = false;
    let routeOptions = [];
    let routeRequestId = 0;
    const mapIsActive = () => state.map === map && Boolean(map.getContainer()?.isConnected);

    const resolveFacility = () => {
      const needle = search.value.trim().toLocaleLowerCase();
      if (!needle) return null;
      return facilities.find(item => item.display.toLocaleLowerCase() === needle)
        || facilities.find(item => item.name.toLocaleLowerCase() === needle)
        || facilities.find(item => `${item.name} ${item.type}`.toLocaleLowerCase().includes(needle));
    };
    const renderNearby = message => {
      const groups = [
        ['hospital', 'Nearby hospitals', latestNearby?.hospital || []],
        ['fire', 'Nearby fire stations', latestNearby?.fire || []]
      ].map(([kind, heading, entries]) => {
        if (!entries.length) return `<div><strong>${heading}</strong><div>No named facilities with a drivable road route were found.</div></div>`;
        const firstFive = entries.slice(0, 5).map((_, index) => index);
        const shown = firstFive.map(index => {
          const item = facilities.find(candidate => candidate.kind === kind && candidate.index === entries[index].index);
          return item ? `<button type="button" class="tool-button nearby-facility" data-nearby-kind="${kind}" data-nearby-index="${entries[index].index}" style="display:block;width:100%;margin:4px 0;text-align:left;">${index + 1}. ${esc(item.name)} · ${fmt(entries[index].distance_km, 2)} km · ${fmt(entries[index].minutes)} min · ${item.lat.toFixed(5)}, ${item.lon.toFixed(5)}</button>` : '';
        }).join('');
        const rest = entries.length > 5
          ? `<details><summary>Show all ${entries.length} facilities</summary>${entries.slice(5).map((entry, index) => {
            const item = facilities.find(candidate => candidate.kind === kind && candidate.index === entry.index);
            return item ? `<button type="button" class="tool-button nearby-facility" data-nearby-kind="${kind}" data-nearby-index="${entry.index}" style="display:block;width:100%;margin:4px 0;text-align:left;">${index + 6}. ${esc(item.name)} · ${fmt(entry.distance_km, 2)} km · ${fmt(entry.minutes)} min · ${item.lat.toFixed(5)}, ${item.lon.toFixed(5)}</button>` : '';
          }).join('')}</details>` : '';
        return `<div><strong>${heading}</strong>${shown}${rest}</div>`;
      }).join('');
      result.innerHTML = `<div>${esc(message)}</div>${latestNearby ? `<div class="nearby-services">${groups}</div>` : ''}${result.dataset.route || ''}`;
    };
    const displayRoute = (route, alternatives = routeOptions) => {
      if (!mapIsActive()) return;
      routeOptions = alternatives.length ? alternatives : [route];
      const activeIndex = Math.max(0, routeOptions.indexOf(route));
      if (routeLayer) map.removeLayer(routeLayer);
      routeLayer = L.layerGroup().addTo(map);
      const color = selectedFacility?.kind === 'fire' ? '#f0524a' : '#4da3ff';
      let activeLine = null;
      routeOptions.forEach((option, index) => {
        const active = index === activeIndex;
        const line = L.polyline(option.line, active
          ? { color, weight: 5, opacity: 0.98 }
          : { color: '#91a9bd', weight: 3, opacity: 0.65, dashArray: '6 7' }).addTo(routeLayer);
        if (active) activeLine = line;
      });
      const bounds = activeLine?.getBounds();
      L.circleMarker(route.facility_ll, { radius: 8, color: '#fff', fillColor: color, fillOpacity: 1 }).addTo(routeLayer);
      if (locationMarker) {
        locationMarker.addTo(map);
        locationMarker.bringToFront();
      }
      if (bounds?.isValid()) map.fitBounds(bounds.pad(0.12), { maxZoom: 15 });
      const choices = routeOptions.map((option, index) => {
        const active = index === activeIndex;
        const directions = active
          ? (option.directions || []).map(step => `<li>${esc(step)}</li>`).join('')
          : '';
        return `<div class="route-card"><button type="button" class="tool-button route-choice" data-route-option="${index}" aria-pressed="${active}">${active ? 'Selected' : 'Use'} · Route ${index + 1}</button><br>${fmt(option.distance_km, 2)} km · ${fmt(option.minutes)} min estimated driving time${directions ? `<details><summary>Road directions</summary><ol>${directions}</ol></details>` : ''}</div>`;
      }).join('');
      result.dataset.route = `<div><strong>Routes to ${esc(route.facility || selectedFacility?.name || 'selected facility')}</strong><div class="route-results">${choices}</div><div class="data-note">${routeOptions.length > 1 ? 'Routes are ordered by estimated free-flow travel time.' : 'Only one distinct road route was found.'} Estimates use the mapped road network; live traffic is not available.</div></div>`;
      recalculateButton.hidden = false;
      renderNearby(`Current location: ${currentLocation.lat.toFixed(5)}, ${currentLocation.lon.toFixed(5)}.`);
    };
    const routeTo = async (selected, preserveMessage = false) => {
      const requestId = ++routeRequestId;
      if (!selected || !currentLocation) {
        if (!preserveMessage) renderNearby('Enable current location and select a named hospital or fire station to request route directions.');
        return;
      }
      selectedFacility = selected;
      search.value = selected.display;
      result.dataset.route = '';
      routeOptions = [];
      renderNearby(`Calculating route to ${selected.name}…`);
      try {
        const query = new URLSearchParams({
          lat: String(currentLocation.lat), lon: String(currentLocation.lon),
          type: selected.kind, index: String(selected.index)
        });
        const response = await fetch(`/api/route?${query}`);
        if (!response.ok) throw new Error(`Route API returned HTTP ${response.status}`);
        const route = await response.json();
        if (requestId !== routeRequestId || !mapIsActive()) return;
        const alternatives = Array.isArray(route.alternatives)
          ? route.alternatives.filter(option => Array.isArray(option.line) && option.line.length)
          : [];
        displayRoute(alternatives[0] || route, alternatives.length ? alternatives : [route]);
      } catch (error) {
        if (requestId !== routeRequestId || !mapIsActive()) return;
        result.dataset.route = '';
        renderNearby(`Route calculation failed: ${error.message}. Route service is unavailable; manual facility search remains available.`);
        console.error('Selected facility route failed', error);
      }
    };
    const loadNearby = async origin => {
      const requestId = ++nearbyRequestId;
      renderNearby('Finding the nearest named hospitals and fire stations by road distance…');
      try {
        const query = new URLSearchParams({ lat: String(origin.lat), lon: String(origin.lon) });
        const response = await fetch(`/api/nearby?${query}`);
        if (!response.ok) throw new Error(`Nearby-services API returned HTTP ${response.status}`);
        const nearby = await response.json();
        if (requestId !== nearbyRequestId || !mapIsActive()) return;
        latestNearby = {
          hospital: Array.isArray(nearby.hospital) ? nearby.hospital : [],
          fire: Array.isArray(nearby.fire) ? nearby.fire : []
        };
        renderNearby(`Current location: ${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}. Nearest facilities are sorted by driving distance.`);
      } catch (error) {
        if (requestId !== nearbyRequestId || !mapIsActive()) return;
        latestNearby = null;
        renderNearby(`Nearby search failed: ${error.message}. Manual facility search remains available.`);
        console.error('Nearby emergency-service search failed', error);
      }
    };
    const updateLocation = position => {
      if (!mapIsActive()) return;
      const next = { lat: position.coords.latitude, lon: position.coords.longitude };
      const moved = !currentLocation || distanceKm(currentLocation, next) >= 0.05;
      currentLocation = next;
      if (!locationMarker) {
        locationMarker = L.circleMarker([next.lat, next.lon], {
          radius: 9, color: '#fff', weight: 2, fillColor: '#168bff', fillOpacity: 1
        }).addTo(map).bindPopup('Your current live location');
      } else {
        locationMarker.setLatLng([next.lat, next.lon]);
      }
      locationButton.textContent = 'Stop live tracking';
      recalculateButton.hidden = !selectedFacility;
      if (!hasInitialLocation) {
        hasInitialLocation = true;
        map.flyTo([next.lat, next.lon], 14);
      }
      if (moved) {
        loadNearby(next);
        if (selectedFacility) routeTo(selectedFacility, true);
      }
    };
    const locationError = error => {
      const message = error.code === 1 ? 'Location permission was denied.' : error.message || 'Unable to read your location.';
      if (error.code === 1 && locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
        locationButton.textContent = 'Use My Current Location';
      }
      renderNearby(`${message} You can still search and open facility information manually.`);
      console.error('Live geolocation failed', error);
    };
    const toggleTracking = () => {
      if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
        locationButton.textContent = 'Use My Current Location';
        renderNearby(currentLocation
          ? `Live tracking stopped. Last location: ${currentLocation.lat.toFixed(5)}, ${currentLocation.lon.toFixed(5)}.`
          : 'Live tracking stopped. Manual facility search remains available.');
        return;
      }
      if (!navigator.geolocation) {
        renderNearby('This browser does not support geolocation. You can still search facilities manually.');
        return;
      }
      renderNearby('Requesting permission for live location…');
      locationWatchId = navigator.geolocation.watchPosition(updateLocation, locationError, {
        enableHighAccuracy: true, maximumAge: 10000, timeout: 20000
      });
    };
    const run = () => {
      const selected = resolveFacility();
      if (!selected) {
        renderNearby(search.value.trim()
          ? 'No matching named facility found. Choose a hospital or fire station from the suggestions.'
          : 'Enter a hospital or fire-station name, or choose one from the suggestions.');
        return;
      }
      selectedFacility = selected;
      map.flyTo([selected.lat, selected.lon], 16);
      L.popup(popupOptions(map)).setLatLng([selected.lat, selected.lon])
        .setContent(facilityPopup(selected.feature, selected.kind === 'fire' ? 'fire' : 'hospitals', selected.index)).openOn(map);
      renderNearby(`Selected: ${selected.name} (${selected.type}).`);
      if (currentLocation) routeTo(selected);
    };
    const selectNearbyFacility = event => {
      const routeChoice = event.target.closest('[data-route-option]');
      if (routeChoice) {
        const route = routeOptions[Number(routeChoice.dataset.routeOption)];
        if (route) displayRoute(route);
        return;
      }
      const target = event.target.closest('[data-nearby-kind][data-nearby-index]');
      if (!target) return;
      const selected = facilities.find(item => item.kind === target.dataset.nearbyKind && item.index === Number(target.dataset.nearbyIndex));
      if (selected) routeTo(selected);
    };
    const navigateFromPopup = event => {
      const target = event.target.closest('[data-route-kind][data-route-index]');
      if (!target) return;
      const selected = facilities.find(item => item.kind === target.dataset.routeKind && item.index === Number(target.dataset.routeIndex));
      if (!selected) return;
      map.closePopup();
      routeTo(selected);
    };
    button.addEventListener('click', run);
    search.addEventListener('keydown', event => { if (event.key === 'Enter') run(); });
    search.addEventListener('change', () => { if (resolveFacility()) run(); });
    locationButton.addEventListener('click', toggleTracking);
    nearbyButton.addEventListener('click', () => {
      if (currentLocation) loadNearby(currentLocation);
      else toggleTracking();
    });
    routeButton.addEventListener('click', () => routeTo(resolveFacility()));
    recalculateButton.addEventListener('click', () => routeTo(selectedFacility));
    result.addEventListener('click', selectNearbyFacility);
    map.getContainer().addEventListener('click', navigateFromPopup);
  }

  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csv(rows, columns) {
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return [columns.join(','), ...rows.map(row => columns.map(column => quote(row[column])).join(','))].join('\r\n');
  }

  function bindReportActions() {
    document.getElementById('exportIncidents')?.addEventListener('click', () => {
      const rows = features(loaded.incidents).map(feature => ({ ...props(feature), longitude: feature.geometry.coordinates[0], latitude: feature.geometry.coordinates[1] }));
      download('eris_incidents.csv', csv(rows, ['type', 'hour', 'est', 'actual', 'latitude', 'longitude']), 'text/csv;charset=utf-8');
    });
    document.getElementById('exportAccess')?.addEventListener('click', () => {
      const rows = features(loaded.demand).map(feature => ({ ...props(feature), longitude: feature.geometry.coordinates[0], latitude: feature.geometry.coordinates[1] }));
      download('eris_network_access_points.csv', csv(rows, ['osmid', 'hosp_min', 'fire_min', 'score', 'priority', 'latitude', 'longitude']), 'text/csv;charset=utf-8');
    });
    document.getElementById('exportGeo')?.addEventListener('click', () => download(
      'eris_facilities.geojson',
      JSON.stringify({ type: 'FeatureCollection', features: [...features(loaded.hospitals), ...features(loaded.fire)] }, null, 2),
      'application/geo+json'
    ));
    document.getElementById('printReport')?.addEventListener('click', () => window.print());
  }

  function renderFeatureWindow() {
    const target = document.getElementById('featureWindow');
    const page = state.activePage;
    const widePage = page === 'Overview' || page === 'Dispatch Center' || page === 'Network Analysis';
    document.getElementById('sidePanel').hidden = widePage;
    document.querySelector('.content-wrap').classList.toggle('wide-content', widePage);
    target.classList.toggle('overview-layout', page === 'Overview');
    if (state.map) {
      if (locationWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
      }
      state.map.stop();
      mapClickHandler?.map.off('click', mapClickHandler.callback);
      state.map.remove();
      state.map = null;
      Object.keys(mapRefs).forEach(key => { delete mapRefs[key]; });
      mapClickHandler = null;
      routeLayer = null;
    }
    if (dispatchAnimationFrame !== null) {
      window.cancelAnimationFrame(dispatchAnimationFrame);
      dispatchAnimationFrame = null;
    }
    dispatchUnitMarker = null;
    document.getElementById('pageTitle').textContent = page;
    chartRefs.forEach(instance => instance.destroy());
    chartRefs.length = 0;
    const renderers = {
      'Overview': renderOverview,
      'Emergency Mapping': renderMapping,
      'Network Analysis': renderNetwork,
      'Predictive Analytics (Demo)': renderAI,
      'Hotspot Heatmaps': renderHeatmaps,
      'Accessibility': renderAccessibility,
      'Facility Optimization': renderOptimization,
      'Planning Recommendations': renderRecommendations,
      'Priority Zones': renderPriorityZones,
      'Dispatch Center': renderDispatch,
      'Reports & Analytics': renderReports
    };
    target.innerHTML = (renderers[page] || renderOverview)();
    target.setAttribute('aria-busy', 'false');
    document.getElementById('kpis').setAttribute('aria-busy', 'false');
    if (page === 'Overview') {
      const map = setupMap('overviewMap', { initialLayers: ['boundary', 'localities', 'hospitals', 'fire'] });
      drawHistogram('overviewResponseHistogram', 'hosp_min', 'Road-node samples', '#4da3ff');
      const veryHigh = features(loaded.demand).filter(feature => props(feature).priority === 'Very High').length;
      document.getElementById('overviewStatus').innerHTML = `<p>Road nodes analyzed: <strong>${Number(state.kpis.road_nodes_analysed || 0).toLocaleString()}</strong></p><p>Very-high access samples: <strong>${veryHigh}</strong></p><p>Incident dataset: <strong>${state.stats.demo ? 'SIMULATED demo' : (state.stats.n ? 'Loaded records' : 'Unavailable')}</strong></p><p class="data-note">Population and population-weighted coverage are not available.</p>`;
      map?.invalidateSize();
    } else if (page === 'Emergency Mapping') {
      const map = setupMap('mappingMap', { initialLayers: ['roads', 'hospitals', 'fire'] });
      bindLayerInputs(map);
      bindFacilityLabels(map);
      bindFacilitySearch(map);
    } else if (page === 'Network Analysis') {
      const map = setupMap('networkMap', {
        initialLayers: ['serviceHosp', 'hospitals', 'fire'],
        clickRoutes: true
      });
      bindLayerInputs(map);
      updateNetworkServiceStatus(10);
      drawCoverageChart('networkAccessChart');
      document.querySelectorAll('[data-service-minutes]').forEach(button => button.addEventListener('click', () => {
        const selected = Number(button.dataset.serviceMinutes);
        drawNetworkServiceAreas(map, selected);
        document.querySelectorAll('[data-service-minutes]').forEach(item => item.classList.toggle('selected', item === button));
        updateNetworkServiceStatus(selected);
      }));
    } else if (page === 'Predictive Analytics (Demo)') {
      drawIncidentTypes('incidentTypeChart');
      drawResponsePairs('responseModelChart');
      drawForecast('forecastChart');
      drawRiskChart('riskChart');
    } else if (page === 'Hotspot Heatmaps') {
      const map = setupMap('heatmapMap', { initialLayers: ['incidentsHeat'] });
      bindLayerInputs(map);
      chart('incidentHourChart', { type: 'bar', data: { labels: Array.from({ length: 24 }, (_, hour) => `${hour}:00`), datasets: [{ label: 'Incident records', data: state.stats.hourly || [], backgroundColor: '#f59e0b' }] }, options: chartOptions });
    } else if (page === 'Accessibility') {
      const map = setupMap('accessibilityMap', { initialLayers: [] });
      if (map) {
        drawAccessibilitySamples(map, 'hosp_min');
        document.getElementById('accessibilityService').addEventListener('change', event => {
          drawAccessibilitySamples(map, event.currentTarget.value);
        });
      }
      drawHistogram('hospitalAccessChart', 'hosp_min', 'Road-node samples', '#4da3ff');
      drawHistogram('fireAccessChart', 'fire_min', 'Road-node samples', '#f0524a');
      drawCoverageChart('accessThresholdChart', { startAtZero: true });
    } else if (page === 'Facility Optimization') {
      const map = setupMap('optimizationMap', { initialLayers: ['hospitals', 'fire', 'candidates'] });
      bindLayerInputs(map);
      const hospital = state.optimization.Hospital || {};
      const fire = state.optimization['Fire station'] || {};
      chart('optimizationChart', { type: 'bar', data: { labels: ['Hospitals', 'Fire stations'], datasets: [
        { label: 'Existing coverage (%)', data: [hospital.coverage_before_pct, fire.coverage_before_pct], backgroundColor: '#2dd4bf' },
        { label: 'With candidate sites (%)', data: [hospital.coverage_after_pct, fire.coverage_after_pct], backgroundColor: '#60a5fa' }
      ] }, options: chartOptions });
    } else if (page === 'Planning Recommendations') {
      drawRecommendationAccessChart('recommendationAccessChart');
    } else if (page === 'Priority Zones') {
      const map = setupMap('priorityMap', { initialLayers: ['priorityZones', 'boundary'] });
      drawRecommendationAccessChart('priorityAccessChart');
      map?.invalidateSize();
    } else if (page === 'Dispatch Center') {
      const map = setupMap('dispatchMap', { initialLayers: ['hospitals', 'fire'] });
      let origin = null;
      let originMarker = null;
      const originText = document.getElementById('dispatchOrigin');
      const callback = event => {
        origin = event.latlng;
        if (originMarker) map.removeLayer(originMarker);
        originMarker = L.circleMarker(origin, { radius: 7, color: '#fff', fillColor: '#f59e0b', fillOpacity: 1 }).addTo(map);
        originText.textContent = `Scenario origin: ${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)}`;
      };
      map.on('click', callback);
      mapClickHandler = { map, callback };
      document.getElementById('dispatchSeverity').addEventListener('change', event => {
        const levels = {
          high: { label: 'High — demo', width: '88%' },
          medium: { label: 'Moderate — demo', width: '58%' },
          low: { label: 'Low — demo', width: '28%' }
        };
        const level = levels[event.currentTarget.value];
        document.getElementById('dispatchSeverityLabel').textContent = level.label;
        const bar = document.getElementById('dispatchSeverityBar');
        bar.dataset.level = event.currentTarget.value;
        bar.style.width = level.width;
      });
      document.getElementById('dispatchRoute').addEventListener('click', async () => {
        if (!origin) {
          originText.textContent = 'Select an origin on the map first.';
          return;
        }
        await requestRoutes(origin, map);
        document.getElementById('routeResults').insertAdjacentHTML('afterbegin',
          `<div class="route-card"><strong>Scenario: ${esc(document.getElementById('dispatchScenario').value)}</strong><br>DEMO route suggestions only · no unit assignment.</div>`);
        statusText('Scenario route calculated only. No emergency unit was dispatched.');
        window.setTimeout(() => document.getElementById('dataStatus')?.remove(), 5000);
      });
    } else if (page === 'Reports & Analytics') {
      drawIncidentTypes('reportTypeChart');
      drawRecommendationAccessChart('reportRiskChart');
      bindReportActions();
    }
  }

  async function loadData() {
    const requests = [
      ['kpis', jsonFetch('kpis.json')],
      ['stats', jsonFetch('incident_stats.json')],
      ['optimization', jsonFetch('optimization.json')],
      ['hospitals', geoFetch('hospitals.geojson')],
      ['fire', geoFetch('fire_stations.geojson')],
      ['roads', geoFetch('road_network.geojson')],
      ['boundary', geoFetch('boundary.geojson')],
      ['localities', geoFetch('localities.geojson')],
      ['demand', geoFetch('demand_points.geojson')],
      ['priorityZones', geoFetch('priority_zones.geojson')],
      ['incidents', geoFetch('incidents.geojson')],
      ['serviceHospitals', geoFetch('service_hospitals.geojson')],
      ['serviceFire', geoFetch('service_fire.geojson')],
      ['recommended', geoFetch('recommended_sites.geojson')],
      ['populationMeta', jsonFetch('population_metadata.json')]
    ];
    const failures = [];
    await Promise.all(requests.map(async ([key, promise]) => {
      try { state[key] = await promise; if (key in loaded) loaded[key] = state[key]; }
      catch (error) {
        if (key === 'populationMeta' && error.message === 'population_metadata.json: HTTP 404') {
          loaded.populationMeta = null;
        } else {
          failures.push(error.message);
          if (key === 'populationMeta') loaded.populationMeta = null;
          else if (key in loaded) loaded[key] = emptyGeo;
          console.error(`Unable to load ERIS data (${key})`, error);
        }
      }
    }));

    if (state.activePage === 'Overview' && location.hash) {
      const requestedPage = decodeURIComponent(location.hash.slice(1));
      if (pages.includes(requestedPage)) state.activePage = requestedPage;
    }
    renderKpis();
    renderSummaryPanel();
    buildNav();
    renderFeatureWindow();
    if (failures.length) statusText(`Some project data could not be loaded: ${failures.join('; ')}`);
    else statusText(state.stats.demo
      ? 'ERIS project data loaded. Incident records are simulated demo data.'
      : 'ERIS project data loaded. Incident records are from the supplied dataset.');
    window.setTimeout(() => document.getElementById('dataStatus')?.remove(), 7000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    buildNav();
    loadData().catch(error => {
      console.error('ERIS dashboard initialization failed', error);
      statusText(`Dashboard data initialization failed: ${error.message}`);
    });
  });
})();
