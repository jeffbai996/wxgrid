// Reserve bandwidth for what is on screen; speculative frames get one slot.
(function () {
  "use strict";
  class FieldRequests {
    constructor(work, retryMs = 500) {
      this.work = work;
      this.retryMs = retryMs;
      this.jobs = new Map();
      this.active = 0;
    }
    request(url, selected) {
      let job = this.jobs.get(url);
      if (job) {
        job.selected ||= selected;
        this.pump();
        return job.promise;
      }
      job = { url, selected, active: false, controller: new AbortController() };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      this.jobs.set(url, job);
      this.pump();
      return job.promise;
    }
    retain(urls) {
      for (const [url, job] of this.jobs) {
        if (urls.has(url)) continue;
        this.jobs.delete(url);
        job.controller.abort();
        job.reject(new DOMException("Superseded", "AbortError"));
      }
    }
    pump() {
      const jobs = [...this.jobs.values()];
      const waiting = jobs.filter(j => !j.active).sort((a, b) => Number(b.selected) - Number(a.selected));
      let speculative = jobs.filter(j => j.active && !j.selected).length;
      for (const job of waiting) {
        if (this.active >= 3) break;
        if (!job.selected && speculative >= 1) continue;
        job.active = true; this.active++;
        if (!job.selected) speculative++;
        this.run(job);
      }
    }
    async run(job) {
      const signal = job.controller.signal;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            signal.throwIfAborted();
            const value = await this.work(job.url, signal, job.selected);
            signal.throwIfAborted();
            job.resolve(value);
            break;
          } catch (err) {
            if (signal.aborted || attempt || (err.status && err.status < 500) || /altered/.test(err.message)) throw err;
            await new Promise(resolve => setTimeout(resolve, this.retryMs));
          }
        }
      } catch (err) { job.reject(err); }
      finally {
        this.active--;
        if (this.jobs.get(job.url) === job) this.jobs.delete(job.url);
        this.pump();
      }
    }
  }
  window.WX.FieldRequests = FieldRequests;
})();
