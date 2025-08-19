/*
	Food Roulette — US Cities
	- User picks a US city (Nominatim), we fetch restaurants via Overpass API (OpenStreetMap)
	- Interactive spinning wheel (SVG)
	- Cuisine exclusion; fast_food/cafe toggles
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

// DOM refs
const statusMessage = document.getElementById("statusMessage");
const wheelGroup = document.getElementById("wheel");
const spinBtn = document.getElementById("spinBtn");
const resultCard = document.getElementById("resultCard");

const pageTitle = document.getElementById("pageTitle");
const cityToggle = document.getElementById("cityToggle");
const cityMenu = document.getElementById("cityMenu");
const citySearch = document.getElementById("citySearch");
const cityResults = document.getElementById("cityResults");

const cuisineToggle = document.getElementById("cuisineToggle");
const cuisineMenu = document.getElementById("cuisineMenu");
const cuisineOptionsEl = document.getElementById("cuisineOptions");
const cuisineSearch = document.getElementById("cuisineSearch");
const selectNoneBtn = document.getElementById("selectNone");
const selectAllBtn = document.getElementById("selectAll");
const includeFastFood = document.getElementById("includeFastFood");
const includeCafe = document.getElementById("includeCafe");
const reloadBtn = document.getElementById("reloadBtn");

// State
let allPlaces = []; // [{id, name, cuisine[], tags, lat, lon, website, phone, street, city}]
let excludedCuisines = new Set();
let uniqueCuisines = [];
let currentFiltered = [];
let isSpinning = false;
let selectedCity = null; // { name, displayName, lat, lon, bbox: {south, west, north, east} }

// --- Utils
function dedupeById(items) {
	const seen = new Set();
	const out = [];
	for (const item of items) {
		if (!seen.has(item.id)) {
			seen.add(item.id);
			out.push(item);
		}
	}
	return out;
}

function extractCuisines(tags) {
	// OSM cuisine can be semicolon-delimited list
	const raw = tags.cuisine || "";
	return String(raw)
		.split(";")
		.map(x => x.trim().toLowerCase())
		.filter(Boolean);
}

function titleCase(str) {
	return str.replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
}

function toPlace(obj) {
	const tags = obj.tags || {};
	const name = tags.name || "Unnamed";
	const cuisine = extractCuisines(tags);
	const website = tags.website || tags.url || "";
	const phone = tags.phone || tags["contact:phone"] || "";
	const street = tags["addr:street"] || "";
	const city = tags["addr:city"] || "";
	return {
		id: `${obj.type}/${obj.id}`,
		name,
		cuisine,
		tags,
		lat: obj.lat,
		lon: obj.lon,
		website,
		phone,
		street,
		city
	};
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
	if (!bbox || !Number.isFinite(lat) || !Number.isFinite(lon)) return 9000;
	const south = parseFloat(bbox.south);
	const west = parseFloat(bbox.west);
	const north = parseFloat(bbox.north);
	const east = parseFloat(bbox.east);
	if (![south, west, north, east].every(Number.isFinite)) return 9000;
	const dNorth = haversineDistanceMeters(lat, lon, north, lon);
	const dSouth = haversineDistanceMeters(lat, lon, south, lon);
	const dEast = haversineDistanceMeters(lat, lon, lat, east);
	const dWest = haversineDistanceMeters(lat, lon, lat, west);
	let r = Math.max(dNorth, dSouth, dEast, dWest) * 1.05; // small padding
	// Clamp radius to keep Overpass happy
	const MIN_R = 2500;
	const MAX_R = 30000;
	if (!Number.isFinite(r) || r <= 0) r = 9000;
	return Math.max(MIN_R, Math.min(MAX_R, r));
}

function buildOverpassQuery() {
	if (!selectedCity || !selectedCity.bbox) throw new Error("No city selected");
	const centerLat = parseFloat(selectedCity.lat);
	const centerLon = parseFloat(selectedCity.lon);
	const radiusM = computeSearchRadiusMeters(selectedCity.bbox, centerLat, centerLon);
	return `[
		out:json][timeout:60];
	(
		node["amenity"~"restaurant|fast_food|cafe"](around:${Math.round(radiusM)},${centerLat},${centerLon});
		way["amenity"~"restaurant|fast_food|cafe"](around:${Math.round(radiusM)},${centerLat},${centerLon});
	);
	out center;`;
}

async function fetchPlaces() {
	const cityName = selectedCity ? selectedCity.name : "your city";
	statusMessage.textContent = `Fetching restaurants near ${cityName}…`;
	const body = new URLSearchParams({ data: buildOverpassQuery() }).toString();
	const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "Accept": "application/json" };
	let json = null;
	let lastErr = null;
	const endpoints = [...OVERPASS_URLS].sort(() => Math.random() - 0.5);
	for (const url of endpoints) {
		try {
			const res = await fetch(url, { method: "POST", headers, body });
			if (!res.ok) throw new Error(`Overpass error: ${res.status} @ ${url}`);
			json = await res.json();
			break;
		} catch (e) {
			lastErr = e;
		}
	}
	if (!json) throw lastErr || new Error("Overpass failed");
	const elements = json.elements || [];
	const nodes = elements.map(el => {
		if (el.type === "node") return { ...el };
		const center = el.center || { lat: undefined, lon: undefined };
		return { id: el.id, type: el.type, lat: center.lat, lon: center.lon, tags: el.tags || {} };
	});
	const places = nodes
		.filter(n => n.tags && n.tags.amenity && ["restaurant","fast_food","cafe"].includes(n.tags.amenity))
		.map(toPlace);
	return dedupeById(places);
}

// --- City search (Nominatim)
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
	// Prefer free-form first
	const pQ = new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "15", countrycodes: "us", q: query });
	const pCity = new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "15", countrycodes: "us", city: query });
	let resultsA = await tryFetch(pQ);
	let resultsB = await tryFetch(pCity);
	let all = [...(Array.isArray(resultsA) ? resultsA : []), ...(Array.isArray(resultsB) ? resultsB : [])];
	// Filter city-like
	all = all.filter(isCityLike);
	// Dedupe by osm_id + class
	const seen = new Set();
	const deduped = [];
	for (const it of all) {
		const key = `${it.class}:${it.osm_id}`;
		if (!seen.has(key)) { seen.add(key); deduped.push(it); }
	}
	if (deduped.length === 0) {
		const photon = await searchCitiesPhoton(query);
		return photon;
	}
	return deduped.slice(0, 15);
}

async function searchCitiesPhoton(query) {
	const headers = { "Accept": "application/json" };
	// Contiguous US bbox to limit results
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
				// Fallback small bbox around point
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
		btn.className = "dropdown-toggle"; // reuse button styling
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
	if (pageTitle) pageTitle.textContent = `Food Roulette — ${city.name}`;
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
		if (pageTitle) pageTitle.textContent = `Food Roulette — ${selectedCity.name}`;
		cityToggle.textContent = selectedCity.name;
	}
}

function updateCuisineOptions() {
	cuisineOptionsEl.innerHTML = "";
	for (const c of uniqueCuisines) {
		const id = `cuisine-${c.replace(/[^a-z0-9]+/g, "-")}`;
		const wrapper = document.createElement("label");
		wrapper.className = "dropdown-option";
		wrapper.innerHTML = `<input type="checkbox" data-cuisine="${c}" ${excludedCuisines.has(c) ? "checked" : ""}/> <span>${titleCase(c)}</span>`;
		cuisineOptionsEl.appendChild(wrapper);
	}
}

function collectUniqueCuisines() {
	const set = new Set();
	for (const p of allPlaces) {
		for (const c of p.cuisine) set.add(c);
	}
	uniqueCuisines = Array.from(set).sort((a, b) => a.localeCompare(b));
}

function applyFilters() {
	const allowed = new Set(uniqueCuisines.filter(c => !excludedCuisines.has(c)));
	currentFiltered = allPlaces.filter(p => {
		// Toggle filters for amenity subtype
		const amenity = p.tags.amenity;
		if (amenity === "fast_food" && !includeFastFood.checked) return false;
		if (amenity === "cafe" && !includeCafe.checked) return false;

		// Cuisine exclusion: if place has cuisines, require at least one allowed
		if (p.cuisine.length > 0) {
			return p.cuisine.some(c => allowed.has(c));
		}
		// If no cuisine listed, include by default
		return true;
	});
	buildWheel(currentFiltered);
	statusMessage.textContent = `${currentFiltered.length} places ready. Click SPIN!`;
	if (currentFiltered.length === 0) {
		statusMessage.textContent = `No places after filters. Adjust filters and reload.`;
	}
}

// --- Wheel rendering
const WHEEL_RADIUS = 500; // matches the viewBox scale roughly
function polarToCartesian(cx, cy, r, angleRadians) {
	return { x: cx + r * Math.cos(angleRadians), y: cy + r * Math.sin(angleRadians) };
}

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
		const start = i * anglePer - Math.PI / 2; // Align first slice at top
		const end = start + anglePer;
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", describeSlicePath(start, end));
		path.setAttribute("class", `slice-fill-${i % 8} slice-stroke`);
		wheelGroup.appendChild(path);

		if (n <= MAX_VISUAL_SLICES) {
			// Label only when not overloaded
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

// --- Spin behavior
let accumulatedRotation = 0; // degrees

function spinWheel() {
	if (isSpinning) return;
	if (!currentFiltered || currentFiltered.length === 0) return;
	isSpinning = true;
	spinBtn.disabled = true;
	resultCard.classList.add("hidden");
	const n = currentFiltered.length;
	const visualCount = Math.min(n, MAX_VISUAL_SLICES);
	const sliceAngle = 360 / visualCount;

	// Preselect a winner uniformly over the entire list
	const chosenIndex = Math.floor(Math.random() * n);
	const chosen = currentFiltered[chosenIndex];

	// Map winner to a visual slice index
	const visualIndex = Math.floor((chosenIndex * visualCount) / n);
	const targetNormalized = visualIndex * sliceAngle + Math.random() * sliceAngle; // random offset within slice

	// Compute offset so that pointer lands inside targetNormalized after rotation
	const currentNormalized = (((-accumulatedRotation + 90) % 360) + 360) % 360;
	const offset = (((currentNormalized - targetNormalized) % 360) + 360) % 360;
	const extraSpins = 4 + Math.floor(Math.random() * 4); // 4..7 full spins
	const finalRotation = accumulatedRotation + extraSpins * 360 + offset;
	accumulatedRotation = finalRotation;

	wheelGroup.style.transition = "transform 5s cubic-bezier(0.12, 0.02, 0, 1)";
	wheelGroup.style.transform = `rotate(${finalRotation}deg)`;

	setTimeout(() => {
		isSpinning = false;
		spinBtn.disabled = false;
		showResult(chosen);
	}, 5200);
}

function showResult(place) {
	const parts = [];
	if (place.street) parts.push(place.street);
	if (place.city) parts.push(place.city);
	const address = parts.join(", ");
	const cuisineStr = place.cuisine.length ? place.cuisine.map(titleCase).join(", ") : "Unspecified";
	const osmLink = `https://www.openstreetmap.org/${place.id}`;
	const cityLabel = selectedCity ? selectedCity.name : "";
	const mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name + " " + (address || cityLabel))}`;
	
	resultCard.innerHTML = `
		<div class="result-name">${place.name}</div>
		<div class="result-meta">Cuisine: ${cuisineStr}</div>
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

// --- Dropdown interactions
cuisineToggle.addEventListener("click", () => {
	const expanded = cuisineMenu.getAttribute("aria-hidden") === "false";
	cuisineMenu.setAttribute("aria-hidden", expanded ? "true" : "false");
	cuisineToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
});

document.addEventListener("click", (e) => {
	if (!cuisineMenu.contains(e.target) && !cuisineToggle.contains(e.target)) {
		cuisineMenu.setAttribute("aria-hidden", "true");
		cuisineToggle.setAttribute("aria-expanded", "false");
	}
});

cuisineSearch.addEventListener("input", () => {
	const q = cuisineSearch.value.trim().toLowerCase();
	for (const label of cuisineOptionsEl.querySelectorAll(".dropdown-option")) {
		const txt = label.textContent.trim().toLowerCase();
		label.style.display = txt.includes(q) ? "flex" : "none";
	}
});

selectNoneBtn.addEventListener("click", () => {
	excludedCuisines = new Set(); // clear exclusions
	updateCuisineOptions();
	applyFilters();
});

selectAllBtn.addEventListener("click", () => {
	excludedCuisines = new Set(uniqueCuisines); // exclude all
	updateCuisineOptions();
	applyFilters();
});

cuisineOptionsEl.addEventListener("change", (e) => {
	const target = e.target;
	if (target && target.matches("input[type=checkbox][data-cuisine]")) {
		const c = target.getAttribute("data-cuisine");
		if (target.checked) {
			excludedCuisines.add(c); // checked = excluded
		} else {
			excludedCuisines.delete(c);
		}
		applyFilters();
	}
});

includeFastFood.addEventListener("change", applyFilters);
includeCafe.addEventListener("change", applyFilters);
reloadBtn.addEventListener("click", async () => {
	if (!selectedCity) {
		statusMessage.textContent = "Select a city first.";
		return;
	}
	await initialize();
});

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
		if (q.length < 2) {
			cityResults.innerHTML = "";
			return;
		}
		citySearchDebounce = setTimeout(async () => {
			const items = await searchCities(q);
			if (items.length === 0) {
				const photonItems = await searchCitiesPhoton(q);
				if (photonItems.length > 0) {
					renderCityResults(photonItems);
				} else {
					renderCityResults([]);
				}
			} else {
				renderCityResults(items);
			}
		}, 250);
	});
}

// --- Initialization
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
		allPlaces = await fetchPlaces();
		collectUniqueCuisines();
		// Default: none excluded
		excludedCuisines = new Set();
		updateCuisineOptions();
		applyFilters();
		spinBtn.disabled = currentFiltered.length === 0;
	} catch (err) {
		console.error(err);
		statusMessage.textContent = "Failed to load data from Overpass. Please try Reload.";
	} finally {
		// no-op
	}
}

// Load prior selection and init
loadSelectedCityFromStorage();
initialize();


