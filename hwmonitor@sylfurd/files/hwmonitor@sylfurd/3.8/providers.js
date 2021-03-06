const Gio = imports.gi.Gio;
const St = imports.gi.St;

//
// Initialize GTop
//

let GTop;
try {
    GTop = imports.gi.GTop;
} catch (e) {
    let icon = new St.Icon({ icon_name: 'utilities-system-monitor',
                           icon_type: St.IconType.FULLCOLOR,
                           icon_size: 24 });
    Main.criticalNotify(_("Dependency missing"), _("Please install the GTop package\n" +
      "\tUbuntu / Mint: gir1.2-gtop-2.0\n" +
      "\tFedora: libgtop2-devel\n" +
      "\tArch: libgtop\n" +_(
			"to use the applet %s")).format(UUID), icon);
    gtopFailed = true;
}

// Class responsible for getting CPU data
class CpuDataProvider {
	constructor() {
        this.gtop = new GTop.glibtop_cpu();
        this.current = 0;
        this.last = 0;
        this.usage = 0;
        this.last_total = 0;
        this.last_delta = 0;
        this.name = _("CPU");
        this.type = "CPU";
    }

    getData() {
        GTop.glibtop_get_cpu(this.gtop);

        this.current = this.gtop.idle;

        let delta = this.gtop.total - this.last_total;
        
        // Sometimes after suspend we get weird values here
        // which results in the graph being flat. This fixes
        // that.
        if (delta < -50000) {
            delta = this.last_delta;
        }

        if (delta > 0) {
            this.usage = (this.current - this.last) / delta;
            this.last = this.current;
            this.last_total = this.gtop.total;
            this.last_delta = delta;
        }

        this.text = ((1-this.usage) * 100).toFixed(1) + "%";
            
        return 1 - this.usage;
    }
}

// Class responsible for getting memory data
class MemDataProvider {
    constructor () {
        this.gtopMem = new GTop.glibtop_mem();
        this.name = _("MEM");
        this.type = "MEM";
    }

    getData() {
        GTop.glibtop_get_mem(this.gtopMem);

        let format = new Tools();
        this.text = format.formatBytes(this.gtopMem.user); 
        return  this.gtopMem.user / this.gtopMem.total;
    }
}

class NetDataProvider {
    // Code is pretty much a copy of the code written by
    // Josef Michálek (Aka Orcus) <0rcus.cz@gmail.com>
    // Credit goes to him for the NetDataProvider
    // called NetData in sysmonitor@orcus
    constructor(frequency, type_in, linlog, max_speed) {
        if (type_in) {
            this.name = _("NET (in)");
            this.type = "NETIN";
        }
        else {
            this.name = _("NET (out)");
            this.type = "NETOUT";
        }
        this.frequency = frequency;
        this.type_in = type_in;
        this.linlog = linlog;
        // Mbit/s
        this.max_speed = max_speed * 1024 * 1024 / 8;

        this.gtop = new GTop.glibtop_netload();
        try {
            // Get network devices from gtop
            let nl = new GTop.glibtop_netlist();
            this.devices = GTop.glibtop.get_netlist(nl);
        }
        catch(e) {
            // Get network devices from filesystem : /sys/class/net
            this.devices = [];
            let d = Gio.File.new_for_path("/sys/class/net");
            let en = d.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
            while ((info = en.next_file(null)))
                this.devices.push(info.get_name())
        }
        // Don't measure loopback interface
        this.devices = this.devices.filter(v => v !== "lo"); 
        try {
            //Workaround, because string match() function throws an error for some reason if called after GTop.glibtop.get_netlist(). After the error is thrown, everything works fine.
            //If the match() would not be called here, the error would be thrown somewhere in Cinnamon applet init code and applet init would fail.
            //Error message: Could not locate glibtop_init_s: ‘glibtop_init_s’: /usr/lib64/libgtop-2.0.so.10: undefined symbol: glibtop_init_s
            //No idea why this error happens, but this workaround works.            
            "".match(/./);    
        }
        catch (e) {
        }
        
        // Retrieve initial net load data
        [this.down_last, this.up_last] = this.getNetLoad();
    }
    
    getData() {
        try {
            let [down, up] = this.getNetLoad();
            let down_delta = (down - this.down_last) / this.frequency;
            let up_delta = (up - this.up_last) / this.frequency;
            this.down_last = down;
            this.up_last = up;
            let format = new Tools();

            if (this.type_in) {
                this.text = format.formatBytes(down_delta);
                if (this.linlog=="lin")
                    return this.getLinearValue(down_delta, this.max_speed);
                else
                    return this.getLogValue(down_delta, this.max_speed);
            }
            else {
                this.text = format.formatBytes(up_delta);
                if (this.linlog=="lin")
                    return this.getLinearValue(up_delta, this.max_speed);
                else
                    return this.getLogValue(up_delta, this.max_speed);
            }
        }
        catch (e) {
            global.logError("Exception in getData():" + e.message);
        }
    }

    getNetLoad() {
        try {
            let down = 0;
            let up = 0;
            for (let i = 0; i < this.devices.length; ++i)
            {
                GTop.glibtop.get_netload(this.gtop, this.devices[i]);
                down += this.gtop.bytes_in;
                up += this.gtop.bytes_out;
            }
            return [down, up];
            }
        catch (e) {
            global.logError("Exception in getNetLoad():" + e.message);
        }
    }

    
    getLinearValue(value, max) {
        if (max<=1 || value<=0)
            return 0;

        let tools = new Tools();
        return tools.limit(value/max, 0, 1);
    }

    getLogValue(value, max) {
        if (max<1 || value<=0)
            return 0;

        let tools = new Tools();
        return tools.limit(Math.log10(value)/Math.log10(max), 0, 1);
    }
};

class Tools {
    //https://stackoverflow.com/questions/15900485/correct-way-to-convert-size-in-bytes-to-kb-mb-gb-in-javascript
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
    
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
        const i = Math.floor(Math.log(bytes) / Math.log(k));
            
        return parseFloat((bytes / Math.pow(k, i)).toPrecision(3)) + ' ' + sizes[i];
    }

    limit(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }
}
