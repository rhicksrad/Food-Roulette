/*
	Booze Roulette — Lafayette, IN
	- Fetches alcohol-serving venues via Overpass API (OpenStreetMap)
	- amenity in [bar, pub], or restaurants/cafes with alcohol=yes (common tag)
	- Spinning wheel UI similar to Food Roulette
*/

const LAFAYETTE_CENTER = { lat: 40.4167, lon: -86.8753 };
const RADIUS_METERS = 12000; // ensure West Lafayette coverage as well
const OVERPASS_URLS = [
	"https://overpass-api.de/api/interpreter",
	"https://z.overpass-api.de/api/interpreter",
	"https://overpass.kumi.systems/api/interpreter",
	"https://overpass.openstreetmap.ru/api/interpreter",
	"https://overpass.osm.ch/api/interpreter"
];

// DOM
const statusMessage = document.getElementById("statusMessage");
const wheelGroup = document.getElementById("wheel");
const spinBtn = document.getElementById("spinBtn");
const resultCard = document.getElementById("resultCard");

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
	if (amenity === "bar" || amenity === "pub" || amenity === "biergarten" || amenity === "nightclub") t.push(amenity);
	// Restaurants/cafes that indicate alcohol explicitly
	const alcoholYes = String(tags.alcohol || tags["serves:alcohol"] || "").toLowerCase() === "yes";
	const drinkYes = ["drink:beer","drink:wine","drink:spirits","drink:cocktails","drink:liquor"].some(k => String(tags[k] || "").toLowerCase() === "yes");
	if ((amenity === "restaurant" || amenity === "cafe") && (alcoholYes || drinkYes)) {
		t.push(amenity);
	}
	// Breweries / taprooms: craft=brewery, brewery=yes, microbrewery=yes, craft_beer=yes (loose)
	if ((tags.craft && String(tags.craft).toLowerCase() === "brewery") || String(tags.brewery || tags.microbrewery || tags.craft_beer || "").toLowerCase() === "yes") {
		t.push("brewery");
	}
	return Array.from(new Set(t));
}

function buildQuery() {
	return `[
		out:json][timeout:25];
	(
		node["amenity"~"bar|pub|biergarten|nightclub"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"bar|pub|biergarten|nightclub"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"bar|pub|biergarten|nightclub"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});

		node["amenity"~"restaurant|cafe"]["alcohol"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"restaurant|cafe"]["alcohol"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"restaurant|cafe"]["alcohol"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});

		node["amenity"~"restaurant|cafe"]["serves:alcohol"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"restaurant|cafe"]["serves:alcohol"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"restaurant|cafe"]["serves:alcohol"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});

		node["amenity"~"restaurant|cafe"]["drink:beer"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"restaurant|cafe"]["drink:beer"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"restaurant|cafe"]["drink:beer"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});

		node["amenity"~"restaurant|cafe"]["drink:wine"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"restaurant|cafe"]["drink:wine"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"restaurant|cafe"]["drink:wine"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});

		node["amenity"~"restaurant|cafe"]["drink:spirits"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"restaurant|cafe"]["drink:spirits"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"restaurant|cafe"]["drink:spirits"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});

		node["amenity"~"restaurant|cafe"]["drink:cocktails"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"restaurant|cafe"]["drink:cocktails"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"restaurant|cafe"]["drink:cocktails"="yes"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});

		node["craft"="brewery"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["craft"="brewery"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["craft"="brewery"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
	);
	out center;`;
}

function buildBarsOnlyQuery() {
	return `[
		out:json][timeout:25];
	(
		node["amenity"~"bar|pub|biergarten|nightclub"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"bar|pub|biergarten|nightclub"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"bar|pub|biergarten|nightclub"](around:${RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
	);
	out center;`;
}

async function fetchOverpass() {
	statusMessage.textContent = "Fetching alcohol venues from OpenStreetMap…";
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
	const all = nodes.map(toPlace)
		.filter(p => p.types.length > 0);
	// Dedupe by id
	const seen = new Set();
	const deduped = [];
	for (const p of all) { if (!seen.has(p.id)) { seen.add(p.id); deduped.push(p); } }
	return deduped;
}

function buildTypesList() {
	const s = new Set();
	for (const p of allPlaces) for (const t of p.types) s.add(t);
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
	currentFiltered = allPlaces.filter(p => p.types.some(t => allowed.has(t)));
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
	const anglePer = (Math.PI * 2) / n;
	for (let i = 0; i < n; i++) {
		const start = i * anglePer - Math.PI / 2;
		const end = start + anglePer;
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", describeSlicePath(start, end));
		path.setAttribute("class", `slice-fill-${i % 8} slice-stroke`);
		wheelGroup.appendChild(path);
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

function spinWheel() {
	if (isSpinning) return;
	if (!currentFiltered || currentFiltered.length === 0) return;
	isSpinning = true; spinBtn.disabled = true; resultCard.classList.add("hidden");
	const n = currentFiltered.length;
	const sliceAngle = 360 / n;
	const extraSpins = 4 + Math.floor(Math.random() * 4);
	const randomPart = Math.random() * 360;
	const finalRotation = accumulatedRotation + extraSpins * 360 + randomPart;
	accumulatedRotation = finalRotation;
	wheelGroup.style.transition = "transform 5s cubic-bezier(0.12, 0.02, 0, 1)";
	wheelGroup.style.transform = `rotate(${finalRotation}deg)`;
	setTimeout(() => {
		isSpinning = false; spinBtn.disabled = false;
		const normalized = (((-finalRotation + 90) % 360) + 360) % 360;
		const index = Math.floor(normalized / sliceAngle) % n;
		showResult(currentFiltered[index]);
	}, 5200);
}

function showResult(place) {
	const parts = [];
	if (place.street) parts.push(place.street);
	if (place.city) parts.push(place.city);
	const address = parts.join(", ");
	const typesStr = place.types.length ? place.types.map(titleCase).join(", ") : "Unspecified";
	const osmLink = `https://www.openstreetmap.org/${place.id}`;
	const mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name + " " + (address || "Lafayette, IN"))}`;
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

// Dropdown interactions
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
reloadBtn.addEventListener("click", async () => { await initialize(); });
spinBtn.addEventListener("click", spinWheel);

async function initialize() {
	try {
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

initialize();


