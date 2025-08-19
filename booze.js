/*
	Booze Roulette — US Cities
	- User picks a US city (Nominatim), we fetch alcohol-serving venues via Overpass API (OpenStreetMap)
	- Includes bars/pubs/nightclubs/biergartens and restaurants/cafes that likely serve alcohol; breweries/taprooms via craft=brewery
	- Interactive spinning wheel (SVG)
	- Wheel visual simplifies beyond 200 slices but selection remains uniform over full list
*/

// --- Constants
const MAX_VISUAL_SLICES = 200;
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = [
	"https://overpass-api.de/api/interpreter",
	"https://z.overpass-api.de/api/interpreter",
	"https://overpass.kumi.systems/api/interpreter",
	"https://overpass.osm.ch/api/interpreter",
	"https://overpass.openstreetmap.ru/api/interpreter"
];

// DOM
const statusMessage = document.getElementById("statusMessage");
const wheelGroup = document.getElementById("wheel");
const spinBtn = document.getElementById("spinBtn");
const resultCard = document.getElementById("resultCard");

const pageTitle = document.getElementById("pageTitle");
const cityToggle = document.getElementById("cityToggle");
const cityMenu = document.getElementById("cityMenu");
const citySearch = document.getElementById("citySearch");
const cityResults = document.getElementById("cityResults");

const typeToggle = document.getElementById("typeToggle");
const typeMenu = document.getElementById("typeMenu");
const typeOptionsEl = document.getElementById("typeOptions");
const typeSearch = document.getElementById("typeSearch");
const typeSelectNone = document.getElementById("typeSelectNone");
const typeSelectAll = document.getElementById("typeSelectAll");
const reloadBtn = document.getElementById("reloadBtn");

// State
let allPlaces = []; // {id, name, tags, lat, lon, website, phone, street, city, types[]}
let excludedTypes = new Set();
let uniqueTypes = [];
let currentFiltered = [];
let isSpinning = false;
let accumulatedRotation = 0;
let selectedCity = null; // { name, displayName, lat, lon, bbox: {south, west, north, east} }

function titleCase(str) { return str.replace(/\b([a-z])/g, (m, c) => c.toUpperCase()); }

function toPlace(el) {
	const tags = el.tags || {};
	const types = collectTypes(tags);
	return {
		id: `${el.type}/${el.id}`,
		name: tags.name || "Unnamed",
		tags,
		lat: el.lat,
		lon: el.lon,
		website: tags.website || tags.url || "",
		phone: tags.phone || tags["contact:phone"] || "",
		street: tags["addr:street"] || "",
		city: tags["addr:city"] || "",
		types
	};
}

function collectTypes(tags) {
	const t = [];
	const amenity = tags.amenity;
	const nameLower = String(tags.name || "").toLowerCase();

	// Direct nightlife venues
	if (amenity === "bar" || amenity === "pub" || amenity === "biergarten" || amenity === "nightclub") t.push(amenity);

	// Heuristics for restaurants/cafes that serve alcohol
	const alcoholYes = String(tags.alcohol || tags["serves:alcohol"] || "").toLowerCase() === "yes";
	const drinkYes = ["drink:beer","drink:wine","drink:spirits","drink:cocktails","drink:liquor"].some(k => String(tags[k] || "").toLowerCase() === "yes");
	const nameSuggestsAlcohol = /(\bbar\b|\bpub\b|tap|brew|ale|lager|ipa\b|wine|spirits|cocktail|whiskey|tavern|saloon|lounge|distill|cider|mead)/i.test(nameLower);
	if ((amenity === "restaurant" || amenity === "cafe") && (alcoholYes || drinkYes || nameSuggestsAlcohol)) {
		t.push(amenity);
	}

	// Breweries / taprooms
	const craft = String(tags.craft || "").toLowerCase();
	const breweryYes = String(tags.brewery || tags.microbrewery || tags.craft_beer || "").toLowerCase() === "yes";
	const taproomYes = String(tags.taproom || tags["tap_room"] || "").toLowerCase() === "yes";
	const brewpub = String(tags["brewery:type"] || tags["brewery"] || "").toLowerCase().includes("brewpub");
	if (craft === "brewery" || breweryYes || taproomYes || brewpub || /tap ?room|brewery|brewing/.test(nameLower)) {
		t.push("brewery");
	}

	return Array.from(new Set(t));
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
	const R = 6371000; // meters
	const toRad = (d) => d * Math.PI / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

function computeSearchRadiusMeters(bbox, lat, lon) {
	if (!bbox || !Number.isFinite(lat) || !Number.isFinite(lon)) return 12000;
	const south = parseFloat(bbox.south);
	const west = parseFloat(bbox.west);
	const north = parseFloat(bbox.north);
	const east = parseFloat(bbox.east);
	if (![south, west, north, east].every(Number.isFinite)) return 12000;
	const dNorth = haversineDistanceMeters(lat, lon, north, lon);
	const dSouth = haversineDistanceMeters(lat, lon, south, lon);
	const dEast = haversineDistanceMeters(lat, lon, lat, east);
	const dWest = haversineDistanceMeters(lat, lon, lat, west);
	let r = Math.max(dNorth, dSouth, dEast, dWest) * 1.05; // padding
	const MIN_R = 2500;
	const MAX_R = 30000;
	if (!Number.isFinite(r) || r <= 0) r = 12000;
	return Math.max(MIN_R, Math.min(MAX_R, r));
}

function buildQuery() {
	if (!selectedCity || !selectedCity.bbox) throw new Error("No city selected");
	const centerLat = parseFloat(selectedCity.lat);
	const centerLon = parseFloat(selectedCity.lon);
	const radiusM = Math.round(computeSearchRadiusMeters(selectedCity.bbox, centerLat, centerLon));
	return `[
		out:json][timeout:60];
	(
		node["amenity"~"bar|pub|biergarten|nightclub|restaurant|cafe"](around:${radiusM},${centerLat},${centerLon});
		way["amenity"~"bar|pub|biergarten|nightclub|restaurant|cafe"](around:${radiusM},${centerLat},${centerLon});
		node["craft"="brewery"](around:${radiusM},${centerLat},${centerLon});
		way["craft"="brewery"](around:${radiusM},${centerLat},${centerLon});
	);
	out center;`;
}

function buildBarsOnlyQuery() {
	if (!selectedCity || !selectedCity.bbox) throw new Error("No city selected");
	const centerLat = parseFloat(selectedCity.lat);
	const centerLon = parseFloat(selectedCity.lon);
	const radiusM = Math.round(computeSearchRadiusMeters(selectedCity.bbox, centerLat, centerLon));
	return `[
		out:json][timeout:60];
	(
		node["amenity"~"bar|pub|biergarten|nightclub"](around:${radiusM},${centerLat},${centerLon});
		way["amenity"~"bar|pub|biergarten|nightclub"](around:${radiusM},${centerLat},${centerLon});
		node["craft"="brewery"](around:${radiusM},${centerLat},${centerLon});
		way["craft"="brewery"](around:${radiusM},${centerLat},${centerLon});
	);
	out center;`;
}

async function fetchOverpass() {
	const cityName = selectedCity ? selectedCity.name : "your city";
	statusMessage.textContent = `Fetching alcohol venues near ${cityName}…`;
	const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "Accept": "application/json" };
	const endpoints = [...OVERPASS_URLS].sort(() => Math.random() - 0.5);
	let lastErr = null;
	// First attempt: broad query
	for (let i = 0; i < endpoints.length; i++) {
		const url = endpoints[i];
		try {
			const body = new URLSearchParams({ data: buildQuery() }).toString();
			const res = await fetch(url, { method: "POST", headers, body });
			if (!res.ok) throw new Error(`Overpass error ${res.status} @ ${url}`);
			const json = await res.json();
			if (json && Array.isArray(json.elements) && json.elements.length > 0) {
				return json.elements;
			}
		} catch (e) {
			lastErr = e;
		}
		// backoff before next endpoint
		await new Promise(r => setTimeout(r, 500 + i * 300));
	}
	// Fallback: bars-only query
	for (let i = 0; i < endpoints.length; i++) {
		const url = endpoints[i];
		try {
			const body = new URLSearchParams({ data: buildBarsOnlyQuery() }).toString();
			const res = await fetch(url, { method: "POST", headers, body });
			if (!res.ok) throw new Error(`Overpass error ${res.status} @ ${url}`);
			const json = await res.json();
			if (json && Array.isArray(json.elements) && json.elements.length > 0) {
				return json.elements;
			}
		} catch (e) {
			lastErr = e;
		}
		await new Promise(r => setTimeout(r, 500 + i * 300));
	}
	throw lastErr || new Error("Overpass returned no elements");
}

async function loadPlaces() {
	const elements = await fetchOverpass();
	const nodes = elements.map(el => {
		if (el.type === "node") return { ...el };
		const center = el.center || { lat: undefined, lon: undefined };
		return { id: el.id, type: el.type, lat: center.lat, lon: center.lon, tags: el.tags || {} };
	});
	const all = nodes.map(toPlace);
	// Dedupe by id
	const seen = new Set();
	const deduped = [];
	for (const p of all) { if (!seen.has(p.id)) { seen.add(p.id); deduped.push(p); } }
	return deduped;
}

function buildTypesList() {
	const s = new Set();
	for (const p of allPlaces) for (const t of p.types) s.add(t);
	if (s.size === 0) {
		for (const p of allPlaces) {
			const a = p.tags && p.tags.amenity;
			if (["bar","pub","biergarten","nightclub"].includes(a)) s.add(a);
			if (p.tags && (p.tags.craft === "brewery" || String(p.tags.brewery || p.tags.microbrewery || "").toLowerCase() === "yes")) s.add("brewery");
		}
	}
	uniqueTypes = Array.from(s).sort((a,b)=>a.localeCompare(b));
}

function updateTypeOptions() {
	typeOptionsEl.innerHTML = "";
	for (const t of uniqueTypes) {
		const label = document.createElement("label");
		label.className = "dropdown-option";
		label.innerHTML = `<input type="checkbox" data-type="${t}" ${excludedTypes.has(t) ? "checked" : ""}/> <span>${titleCase(t)}</span>`;
		typeOptionsEl.appendChild(label);
	}
}

function applyFilters() {
	const allowed = new Set(uniqueTypes.filter(t => !excludedTypes.has(t)));
	if (uniqueTypes.length === 0) {
		currentFiltered = allPlaces.filter(p => {
			const a = p.tags && p.tags.amenity;
			return ["bar","pub","biergarten","nightclub"].includes(a) || (p.tags && (p.tags.craft === "brewery" || String(p.tags.brewery || p.tags.microbrewery || "").toLowerCase() === "yes"));
		});
	} else {
		currentFiltered = allPlaces.filter(p => p.types.some(t => allowed.has(t)));
	}
	buildWheel(currentFiltered);
	statusMessage.textContent = `${currentFiltered.length} places ready. Click SPIN!`;
	spinBtn.disabled = currentFiltered.length === 0;
}

// Wheel
const WHEEL_RADIUS = 500;
function polarToCartesian(cx, cy, r, a) { return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; }
function describeSlicePath(startAngle, endAngle) {
	const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
	const start = polarToCartesian(0, 0, WHEEL_RADIUS, startAngle);
	const end = polarToCartesian(0, 0, WHEEL_RADIUS, endAngle);
	return `M 0 0 L ${start.x} ${start.y} A ${WHEEL_RADIUS} ${WHEEL_RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}
function buildWheel(places) {
	while (wheelGroup.firstChild) wheelGroup.removeChild(wheelGroup.firstChild);
	if (!places || places.length === 0) return;
	const n = places.length;
	const visualCount = Math.min(n, MAX_VISUAL_SLICES);
	const anglePer = (Math.PI * 2) / visualCount;
	for (let i = 0; i < visualCount; i++) {
		const start = i * anglePer - Math.PI / 2;
		const end = start + anglePer;
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", describeSlicePath(start, end));
		path.setAttribute("class", `slice-fill-${i % 8} slice-stroke`);
		wheelGroup.appendChild(path);
		if (n <= MAX_VISUAL_SLICES) {
			const mid = (start + end) / 2;
			const labelR = WHEEL_RADIUS * 0.65;
			const { x, y } = polarToCartesian(0, 0, labelR, mid);
			const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
			text.setAttribute("x", String(x));
			text.setAttribute("y", String(y));
			text.setAttribute("class", "slice-text");
			const name = places[i].name.length > 28 ? places[i].name.slice(0, 27) + "…" : places[i].name;
			text.textContent = name;
			wheelGroup.appendChild(text);
		}
	}
}

function spinWheel() {
	if (isSpinning) return;
	if (!currentFiltered || currentFiltered.length === 0) return;
	isSpinning = true; spinBtn.disabled = true; resultCard.classList.add("hidden");
	const n = currentFiltered.length;
	const visualCount = Math.min(n, MAX_VISUAL_SLICES);
	const sliceAngle = 360 / visualCount;
	// Preselect winner uniformly
	const chosenIndex = Math.floor(Math.random() * n);
	const chosen = currentFiltered[chosenIndex];
	const visualIndex = Math.floor((chosenIndex * visualCount) / n);
	const targetNormalized = visualIndex * sliceAngle + Math.random() * sliceAngle;
	const currentNormalized = (((-accumulatedRotation + 90) % 360) + 360) % 360;
	const offset = (((currentNormalized - targetNormalized) % 360) + 360) % 360;
	const extraSpins = 4 + Math.floor(Math.random() * 4);
	const finalRotation = accumulatedRotation + extraSpins * 360 + offset;
	accumulatedRotation = finalRotation;
	wheelGroup.style.transition = "transform 5s cubic-bezier(0.12, 0.02, 0, 1)";
	wheelGroup.style.transform = `rotate(${finalRotation}deg)`;
	setTimeout(() => {
		isSpinning = false; spinBtn.disabled = false;
		showResult(chosen);
	}, 5200);
}

function showResult(place) {
	const parts = [];
	if (place.street) parts.push(place.street);
	if (place.city) parts.push(place.city);
	const address = parts.join(", ");
	const typesStr = place.types.length ? place.types.map(titleCase).join(", ") : "Unspecified";
	const osmLink = `https://www.openstreetmap.org/${place.id}`;
	const cityLabel = selectedCity ? selectedCity.name : "";
	const mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name + " " + (address || cityLabel))}`;
	resultCard.innerHTML = `
		<div class="result-name">${place.name}</div>
		<div class="result-meta">Type: ${typesStr}</div>
		${address ? `<div class="result-meta">Address: ${address}</div>` : ""}
		${place.phone ? `<div class="result-meta">Phone: ${place.phone}</div>` : ""}
		<div class="result-links">
			<a href="${mapLink}" target="_blank" rel="noopener">Open in Google Maps</a>
			<a href="${osmLink}" target="_blank" rel="noopener">OpenStreetMap</a>
			${place.website ? `<a href="${place.website}" target="_blank" rel="noopener">Website</a>` : ""}
		</div>
	`;
	resultCard.classList.remove("hidden");
}

// Dropdown interactions (types)
if (typeToggle && typeMenu) {
	typeToggle.addEventListener("click", () => {
		const expanded = typeMenu.getAttribute("aria-hidden") === "false";
		typeMenu.setAttribute("aria-hidden", expanded ? "true" : "false");
		typeToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
	});
	document.addEventListener("click", (e) => {
		if (!typeMenu.contains(e.target) && !typeToggle.contains(e.target)) {
			typeMenu.setAttribute("aria-hidden", "true");
			typeToggle.setAttribute("aria-expanded", "false");
		}
	});
	typeSearch.addEventListener("input", () => {
		const q = typeSearch.value.trim().toLowerCase();
		for (const label of typeOptionsEl.querySelectorAll(".dropdown-option")) {
			const txt = label.textContent.trim().toLowerCase();
			label.style.display = txt.includes(q) ? "flex" : "none";
		}
	});
	typeOptionsEl.addEventListener("change", (e) => {
		const target = e.target;
		if (target && target.matches("input[type=checkbox][data-type]")) {
			const t = target.getAttribute("data-type");
			if (target.checked) excludedTypes.add(t); else excludedTypes.delete(t);
			applyFilters();
		}
	});
	typeSelectNone.addEventListener("click", () => { excludedTypes = new Set(); updateTypeOptions(); applyFilters(); });
	typeSelectAll.addEventListener("click", () => { excludedTypes = new Set(uniqueTypes); updateTypeOptions(); applyFilters(); });
}

// City search (Nominatim + Photon fallback)
function formatCityLabel(item) {
	const addr = item.address || {};
	const city = addr.city || addr.town || addr.village || addr.borough || addr.hamlet || addr.municipality || addr.county || "";
	const state = addr.state || addr.region || "";
	const shortState = (addr.state_code || (state && state.match(/\b([A-Z]{2})\b/) ? state.match(/\b([A-Z]{2})\b/)[1] : "")).toUpperCase();
	const stateOut = shortState || state;
	return `${city}${city && stateOut ? ", " : ""}${stateOut}`.trim() || (item.display_name || "Unknown");
}
function isCityLike(item) {
	const cls = item.class;
	const type = item.type;
	const at = item.addresstype || "";
	const addr = item.address || {};
	const placeTypes = new Set(["city","town","village","borough","hamlet","suburb","neighbourhood","city_district","municipality","township","locality","cdp"]);
	if (cls === "place" && placeTypes.has(type)) return true;
	if (cls === "boundary" && type === "administrative") {
		if (placeTypes.has(at)) return true;
		if (addr.city || addr.town || addr.village || addr.borough || addr.municipality) return true;
	}
	return false;
}
async function searchCities(query) {
	const headers = { "Accept": "application/json" };
	const tryFetch = async (params) => {
		try {
			const res = await fetch(`${NOMINATIM_ENDPOINT}?${params.toString()}`, { headers });
			if (res.ok) return await res.json();
		} catch (e) { /* ignore */ }
		return [];
	};
	const pQ = new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "15", countrycodes: "us", q: query });
	const pCity = new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "15", countrycodes: "us", city: query });
	let resultsA = await tryFetch(pQ);
	let resultsB = await tryFetch(pCity);
	let all = [...(Array.isArray(resultsA) ? resultsA : []), ...(Array.isArray(resultsB) ? resultsB : [])];
	all = all.filter(isCityLike);
	const seen = new Set();
	const deduped = [];
	for (const it of all) { const key = `${it.class}:${it.osm_id}`; if (!seen.has(key)) { seen.add(key); deduped.push(it); } }
	if (deduped.length === 0) return await searchCitiesPhoton(query);
	return deduped.slice(0, 15);
}
async function searchCitiesPhoton(query) {
	const headers = { "Accept": "application/json" };
	const bboxUS = "-124.848974,24.396308,-66.885444,49.384358";
	const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&lang=en&limit=15&bbox=${bboxUS}`;
	try {
		const res = await fetch(url, { headers });
		if (!res.ok) return [];
		const json = await res.json();
		if (!json || !Array.isArray(json.features)) return [];
		const out = [];
		for (const f of json.features) {
			const p = f.properties || {};
			const g = f.geometry || {};
			const coords = Array.isArray(g.coordinates) ? g.coordinates : [undefined, undefined];
			const lon = parseFloat(coords[0]);
			const lat = parseFloat(coords[1]);
			const value = String(p.osm_value || p.type || "");
			const key = String(p.osm_key || "");
			const name = p.name || p.city || "";
			if (key !== "place") continue;
			const allowed = new Set(["city","town","village","borough","hamlet","suburb","neighbourhood","municipality","locality"]);
			if (!allowed.has(value)) continue;
			const extent = p.extent; // [west, south, east, north]
			let bbox;
			if (Array.isArray(extent) && extent.length === 4) {
				const west = parseFloat(extent[0]);
				const south = parseFloat(extent[1]);
				const east = parseFloat(extent[2]);
				const north = parseFloat(extent[3]);
				bbox = [south, north, west, east];
			} else if (Number.isFinite(lat) && Number.isFinite(lon)) {
				const dLat = 0.05, dLon = 0.05;
				bbox = [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
			} else {
				continue;
			}
			const display_name = `${name}${p.state ? ", " + p.state : ""}`;
			out.push({
				class: "place",
				type: value,
				addresstype: value,
				address: { city: p.city || name, state: p.state || "", state_code: "", country_code: (p.countrycode || "").toUpperCase() },
				display_name,
				lat: String(lat),
				lon: String(lon),
				boundingbox: bbox.map(n => String(n)),
				osm_id: `photon:${p.osm_type || ""}:${p.osm_id || name}`
			});
		}
		return out;
	} catch (e) {
		return [];
	}
}
function renderCityResults(items) {
	cityResults.innerHTML = "";
	if (!items || items.length === 0) {
		const div = document.createElement("div");
		div.className = "dropdown-option";
		div.textContent = "No results";
		cityResults.appendChild(div);
		return;
	}
	for (const item of items) {
		const label = formatCityLabel(item);
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "dropdown-toggle";
		btn.style.width = "100%";
		btn.style.textAlign = "left";
		btn.textContent = label;
		btn.addEventListener("click", () => {
			const bb = item.boundingbox || [];
			// Nominatim order: [south, north, west, east]
			const south = parseFloat(bb[0]);
			const north = parseFloat(bb[1]);
			const west = parseFloat(bb[2]);
			const east = parseFloat(bb[3]);
			const cityObj = {
				name: label,
				displayName: item.display_name || label,
				lat: parseFloat(item.lat),
				lon: parseFloat(item.lon),
				bbox: { south, west, north, east }
			};
			setSelectedCity(cityObj);
			cityMenu.setAttribute("aria-hidden", "true");
			cityToggle.setAttribute("aria-expanded", "false");
		});
		cityResults.appendChild(btn);
	}
}
function setSelectedCity(city) {
	selectedCity = city;
	try { localStorage.setItem("fr_selected_city", JSON.stringify(city)); } catch (e) { /* ignore */ }
	if (pageTitle) pageTitle.textContent = `Booze Roulette — ${city.name}`;
	cityToggle.textContent = city.name;
	statusMessage.textContent = `Loading data for ${city.name}…`;
	initialize();
}
function loadSelectedCityFromStorage() {
	try {
		const raw = localStorage.getItem("fr_selected_city");
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && parsed.bbox) selectedCity = parsed;
		}
	} catch (e) { /* ignore */ }
	if (selectedCity) {
		if (pageTitle) pageTitle.textContent = `Booze Roulette — ${selectedCity.name}`;
		cityToggle.textContent = selectedCity.name;
	}
}

reloadBtn.addEventListener("click", async () => { if (!selectedCity) { statusMessage.textContent = "Select a city first."; return; } await initialize(); });
spinBtn.addEventListener("click", spinWheel);

// City dropdown interactions
if (cityToggle && cityMenu && citySearch && cityResults) {
	cityToggle.addEventListener("click", () => {
		const expanded = cityMenu.getAttribute("aria-hidden") === "false";
		cityMenu.setAttribute("aria-hidden", expanded ? "true" : "false");
		cityToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
		if (!expanded) {
			cityResults.innerHTML = "";
			if (citySearch.value.trim().length >= 2) {
				searchCities(citySearch.value.trim()).then(renderCityResults);
			}
		}
	});
	document.addEventListener("click", (e) => {
		if (!cityMenu.contains(e.target) && !cityToggle.contains(e.target)) {
			cityMenu.setAttribute("aria-hidden", "true");
			cityToggle.setAttribute("aria-expanded", "false");
		}
	});
	let citySearchDebounce = null;
	citySearch.addEventListener("input", () => {
		const q = citySearch.value.trim();
		clearTimeout(citySearchDebounce);
		if (q.length < 2) { cityResults.innerHTML = ""; return; }
		citySearchDebounce = setTimeout(async () => {
			const items = await searchCities(q);
			renderCityResults(items);
		}, 250);
	});
}

async function initialize() {
	try {
		if (!selectedCity) {
			spinBtn.disabled = true;
			statusMessage.textContent = "Select a city to start.";
			while (wheelGroup.firstChild) wheelGroup.removeChild(wheelGroup.firstChild);
			return;
		}
		spinBtn.disabled = true;
		statusMessage.textContent = "Loading data…";
		resultCard.classList.add("hidden");
		allPlaces = await loadPlaces();
		buildTypesList();
		excludedTypes = new Set();
		updateTypeOptions();
		applyFilters();
	} catch (e) {
		console.error(e);
		statusMessage.textContent = "Failed to load data from Overpass. Please try Reload.";
	}
}

// Load prior selection and init
loadSelectedCityFromStorage();
initialize();


