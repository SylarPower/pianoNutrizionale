/* Pure domain services. No recipe data lives here. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  const VERSION = 4;
  const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const aliases = {
    'uovo intero':'whole-eggs','uova intere':'whole-eggs','uova intere sode':'whole-eggs','uova intere barzotte':'whole-eggs',
    'pomodorini':'cherry-tomatoes','salmone':'salmon','tonno al naturale sgocciolato':'tuna',
    'yogurt greco magro o skyr':'greek-yogurt','pane integrale o di segale':'whole-grain-bread','limone':'lemon','zucchine':'zucchini'
  };
  const slug = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[()]/g,' ').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  function ingredientIdFor(name, existing) { const key = String(name || '').trim().toLowerCase().replace(/\s+/g,' '); return existing || aliases[key] || slug(key) || 'ingredient'; }
  function normalizePortions(p={}) { return { ipoTraining:p.ipoTraining ?? p.ipo ?? '—', ipoRest:p.ipoRest ?? p.ipo ?? '—', manTraining:p.manTraining ?? p.training ?? '—', manRest:p.manRest ?? p.rest ?? p.training ?? '—' }; }
  function migrateRecipe(recipe) { return {...recipe, ingredients:(recipe.ingredients||[]).map(i=>({...i, ingredientId:ingredientIdFor(i.name,i.ingredientId), portions:normalizePortions(i.portions)}))}; }
  function migrateCatalog(doc={}) { const recipes=(doc.recipes||[]).map(migrateRecipe); return {...doc, schemaVersion:VERSION, recipes, recipeCount:recipes.length, ingredientAliases:{...aliases}, batchTemplates:doc.batchTemplates || migrateBatchRules(doc.batchRules)}; }
  function migrateBatchRules(rules={}) { return Object.entries(rules).map(([day, rule])=>({id:`legacy-${day}-${rule.dinner||'dinner'}-${rule.nextLunch||'lunch'}`, anchor:{slot:'dinner',recipeId:rule.dinner}, target:{slot:'lunch',recipeId:rule.nextLunch,lookAheadDays:1}, tasks:(rule.actions||[]).map((label,i)=>({id:`legacy-${day}-${i}`,actionType:'prepare',label:String(label).replace(/^\[.*?\]\s*/,''),storage:{method:'fridge',maxDays:1,instructions:'Durata prudenziale migrata: validare per sicurezza alimentare.'}})), legacyDay:day})); }
  function dayDistance(from,to){ const a=DAYS.indexOf(from), b=DAYS.indexOf(to); return (b-a+7)%7; }
  function futureTarget(day, plan, targetSlot, recipeId, maxDays=7){ for(let n=1;n<=maxDays;n++){const d=DAYS[(DAYS.indexOf(day)+n)%7]; if(plan?.days?.[d]?.[targetSlot]===recipeId)return {day:d,days:n};} return null; }
  function activeBatch(anchorDay, plan, templates, maxDays=7){ const dinner=plan?.days?.[anchorDay]?.dinner; return (templates||[]).filter(t=>t.anchor?.recipeId===dinner).map(t=>{const target=futureTarget(anchorDay,plan,t.target?.slot||'lunch',t.target?.recipeId,maxDays); if(!target)return null; const today=[], later=[]; (t.tasks||[]).forEach(task=>((task.storage?.maxDays||0)===0?later:today).push(task)); return {...t,targetDay:target.day,daysUntilTarget:target.days,prepareToday:today,prepareLater:later};}).filter(Boolean); }
  function portionFor(ingredient, profile, type){ const p=normalizePortions(ingredient?.portions); return p[profile==='ipo'?(type==='training'?'ipoTraining':'ipoRest'):(type==='training'?'manTraining':'manRest')]; }
  function aggregateShopping(plan, recipesById, selectedMeals, profile='man'){ const out={}; DAYS.forEach(day=>(selectedMeals?.[day]||[]).forEach(slot=>{const r=recipesById?.[plan?.days?.[day]?.[slot]]; if(!r)return; (r.ingredients||[]).forEach(i=>{const amount=portionFor(i,profile,plan.days[day].type); if(['—','-',''].includes(String(amount).trim()))return; const id=ingredientIdFor(i.name,i.ingredientId); if(!out[id])out[id]={ingredientId:id,name:i.name,amounts:[]}; out[id].amounts.push({day,amount});});})); return Object.values(out); }
  function swapMeals(plan,dayA,slotA,dayB,slotB){ if(slotA!==slotB) throw new Error('Gli slot devono essere compatibili'); const next=JSON.parse(JSON.stringify(plan)); [next.days[dayA][slotA],next.days[dayB][slotB]]=[next.days[dayB][slotB],next.days[dayA][slotA]]; return next; }
  function copyMeal(plan,fromDay,slot,toDay){ if(!plan.days?.[fromDay]||!plan.days?.[toDay])throw new Error('Giorno non valido'); const next=JSON.parse(JSON.stringify(plan)); next.days[toDay][slot]=next.days[fromDay][slot]; return next; }
  return {VERSION,aliases,ingredientIdFor,normalizePortions,migrateRecipe,migrateCatalog,migrateBatchRules,futureTarget,activeBatch,aggregateShopping,swapMeals,copyMeal};
});
