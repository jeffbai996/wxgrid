const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const WX = {state:{model:'wn2'},units:{tempC:v=>({v:Math.round(v)}),precip:v=>({txt:v+' mm'}),timeOpts:o=>o},
  speed:v=>v,speedUnit:()=> 'm/s',rampColor:()=> '#abc',tape:{glyph:()=>''}};
const ctx={window:{WX},localStorage:{getItem:()=>null},setTimeout:()=>{},document:{querySelectorAll:()=>[]}};
const src=fs.readFileSync('front/panes.js','utf8').replace('window.WXPanes = { render, sunTimes, canSnow };',
 'window.WXPanes = { bucketWindow, sumWindow, dryWindow, bigGlyph, daysStrip, completeDay, diagnosticNote };');
vm.runInNewContext(src,ctx);const h=ctx.window.WXPanes;
const obj=x=>JSON.parse(JSON.stringify(x));
const d=(rain,steps=[6,12,18])=>({model:'wn2',steps,valid:steps.map(v=>new Date(Date.UTC(2030,0,1,v)).toISOString()),series:{tp6:rain,t2m:steps.map(()=>280)}});
test('WN six-hour rain buckets sum once, without cumulative differencing',()=>{
 assert.deepEqual(obj(h.bucketWindow([1,2,3,4,5],[6,12,18,24,30],0,24)),{total:14,hours:24,complete:true});
});
test('truncated rain reports only covered hours and strict totals stay unavailable',()=>{
 assert.deepEqual(obj(h.bucketWindow([0,2,3],[6,12,18],0,24)),{total:5,hours:12,complete:false});
 assert.equal(h.sumWindow([0,2,3],[6,12,18],0,24),null);
});
test('null or missing precipitation and gaps never become zero rain',()=>{
 assert.equal(h.bucketWindow([0,2,null,4],[6,12,18,24],0,24).hours,6);
 assert.equal(h.bucketWindow([0,4],[6,18],0,24).hours,0);
 assert.equal(h.bucketWindow(null,[6,12],0,24).total,null);
});
test('dry spell stops at forecast end or unknown buckets',()=>{
 assert.equal(h.dryWindow(d([0,0,0]),0).hours,12);
 assert.equal(h.dryWindow(d([0,null,0]),0).hours,0);
 assert.equal(h.dryWindow(d([0,0,0]),2).hours,0);
 assert.equal(h.dryWindow(d([0,0,1]),0).wetIn,12);
});
test('hero unknown cloud is explicit; wet weather still gets rain without a sun',()=>{
 assert.match(h.bigGlyph(null,0,280,false),/Cloud forecast unavailable/);
 assert.doesNotMatch(h.bigGlyph(null,0,280,false),/#ffd166/);
 assert.match(h.bigGlyph(null,1,280,false),/#69b9ff/);
 assert.doesNotMatch(h.bigGlyph(null,1,280,false),/#ffd166/);
 assert.match(h.bigGlyph(0,0,280,false),/#ffd166/);
});
test('tape unknown cloud does not become sunshine',()=>{
 const c={window:{WX:{state:{}}},localStorage:{getItem:()=>null}};
 vm.runInNewContext(fs.readFileSync('front/tape.js','utf8'),c);
 assert.match(c.window.WX.tape.glyph(null,0,280,false),/Cloud forecast unavailable/);
 assert.doesNotMatch(c.window.WX.tape.glyph(null,1,280,false),/#ffd166/);
});
test('a final single-sample day stays visible and explicitly partial',()=>{
 const forecast=d([1],[6]);const html=h.daysStrip({data:forecast},forecast,0);
 assert.match(html,/partial/);assert.match(html,/available forecast periods/);
 assert.match(html,/data-valid=/);assert.match(html,/<i>—<\/i>/);
});
test('full days require 24 hours of samples, including three-hour models',()=>{
 const f=d(Array(8).fill(0),[0,3,6,9,12,15,18,21]);
 assert.equal(h.completeDay(f,[0,1,2,3]),false);
 assert.equal(h.completeDay(f,[0,1,2,3,4,5,6,7]),true);
 f.series.t2m[3]=null;assert.equal(h.completeDay(f,[0,1,2,3,4,5,6,7]),false);
});
test('all-null temperatures do not create a daily forecast',()=>{
 const f=d([0],[6]);f.series.t2m=[null];
 assert.doesNotMatch(h.daysStrip({data:f},f,0),/data-valid=/);
});
test('missing WN diagnostics are named without inventing values',()=>{
 assert.match(h.diagnosticNote(d([0])),/cloud cover, dew point, gusts, CAPE, waves/);
 assert.equal(h.diagnosticNote({...d([0]),model:'aifs'}),'');
});

test('WN permalink preserves its internal numeric model ID and legacy links',()=>{
 const app=fs.readFileSync('front/app.js','utf8');
 const fn=app.match(/function readHash\(\) \{[\s\S]*?\n  \}/)[0];
 const parse=hash=>vm.runInNewContext('('+fn+')()', {location:{hash}});
 assert.equal(parse('#49.28,-123.12,5;wn2;temp;s19;p49.28,-123.12').model,'wn2');
 assert.equal(parse('#49.28,-123.12,5;wn2;temp;s19;p49.28,-123.12').step,19);
 assert.equal(parse('#49.28,-123.12,5;aifs;wind').model,'aifs');
});

test('unknown conditions have a visible vector glyph in hero and compact cards',()=>{
 const big=h.bigGlyph(null,0,280,false);
 assert.match(big,/unknown-weather/);assert.match(big,/<circle/);assert.match(big,/<path/);
 assert.doesNotMatch(big,/<text/);assert.doesNotMatch(big,/#ffd166/);
 const c={window:{WX:{state:{}}},localStorage:{getItem:()=>null}};
 vm.runInNewContext(fs.readFileSync('front/tape.js','utf8'),c);
 const small=c.window.WX.tape.glyph(null,0,280,true);
 assert.match(small,/unknown-weather/);assert.match(small,/<path/);
 assert.doesNotMatch(small,/<text/);
 assert.match(c.window.WX.tape.glyph(null,1,280,false),/#69b9ff/);
 assert.match(c.window.WX.tape.glyph(0,0,280,false),/#ffd166/);
});
