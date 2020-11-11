import TransportWebUSB from "@ledgerhq/hw-transport-webusb";

const GET_APP_INFO_COMMAND = 0x01;
const GET_APP_CONFIG_COMMAND = 0x03;
const DUMP_METADATAS_COMMAND = 0x04;
const LOAD_METADATAS_COMMAND = 0x05;

class PasswordsManager {
    constructor() {
        this.allowedStatuses = [0x9000, 0x6985, 0x6A86, 0x6A87, 0x6D00, 0x6E00, 0xB000];
        this.connected = false;
        this.busy = false;
        this.transport = null;
    }

    async connect() {
        if (!this.connected) {
            if (!this.transport) this.transport = await TransportWebUSB.create();
            try {
                const [appName, version] = await this.getAppInfo();
                if (appName.toString() !== "Passwords") throw new Error("The Passwords app is not opened on the device");
                this.version = version;
                let appConfig = await this.getAppConfig();
                this.storage_size = appConfig["storage_size"];
                this.connected = true;
            }
            catch (error) {
                await this.transport.close();
                this.disconnect();
                throw error;
            }
        }
    }

    isSuccess(result) {
        return result.length >= 2 && result.readUInt16BE(result.length - 2) === 0x9000;
    }

    disconnect() {
        this.connected = false;
        this.transport = null;
    }

    mapProtocolError(result) {
        if (result.length < 2) throw new Error("Response length is too small");

        var errors = {
            0x6985: "Action cancelled",
            0x6A86: "SW_WRONG_P1P2",
            0x6A87: "SW_WRONG_DATA_LENGTH",
            0x6D00: "SW_INS_NOT_SUPPORTED",
            0x6E00: "SW_CLA_NOT_SUPPORTED",
            0xB000: "SW_APPNAME_TOO_LONG",
            0x6F10: "SW_METADATAS_PARSING_ERROR"
        }

        let error = result.readUInt16BE(result.length - 2);
        if (error in errors) {
            throw new Error(errors[error]);
        }
    }

    _lock() {
        if (this.busy) throw new Error("Device is busy");
        this.busy = true;
    }

    _unlock() {
        this.busy = false;
    }

    _toBytes(json_metadatas) {
        let metadatas = Buffer.alloc(this.storage_size);
        let parsed_metadatas = JSON.parse(json_metadatas)["parsed"];
        let offset = 0;
        parsed_metadatas.forEach(element => {
            let nickname = element["nickname"];
            let charsets = element["charsets"];
            if (nickname.length > 19) throw new Error(`Nickname too long (19 max): ${nickname} has length ${nickname.length}`);
            if (offset + 3 + nickname.length >= this.storage_size) throw new Error(`Not enough memory on this device to restore this backup`);
            metadatas[offset++] = nickname.length + 1;
            metadatas[offset++] = 0x00;
            metadatas[offset++] = charsets;
            metadatas.write(nickname, offset);
            offset += nickname.length;
        });
        // mark free space at the end of the buffer
        metadatas[offset++] = 0x00;
        metadatas[offset++] = 0x00;
        return metadatas
    }

    _toJSON(metadatas) {
        let metadatas_list = [];
        let erased_list = [];
        let offset = 0;
        let corruptions = [];
        while (true) {
            let len = metadatas[offset];
            if (len === 0) break;
            let erased = metadatas[offset + 1] === 0xFF ? true : false;
            let charsets = metadatas[offset + 2];
            if (len > 19 + 1) corruptions += [offset, `nickname too long ${len}, max is 19`]
            if (!erased) {
                metadatas_list.push({
                    "nickname": metadatas.slice(offset + 3, offset + 2 + len).toString(),
                    "charsets": charsets
                });
            }
            else {
                erased_list.push({
                    "nickname": metadatas.slice(offset + 3, offset + 2 + len).toString(),
                    "charsets": charsets
                });
            }
            offset += len + 2;
        }
        return {
            "parsed": metadatas_list,
            "nicknames_erased_but_still_stored": erased_list,
            "corruptions_encountered": corruptions,
            "raw_metadatas": metadatas.toString("hex")
        };
    }

    async _load_metadatas_chunk(chunk, is_last) {
        let result = await this.transport.send(0xE0, LOAD_METADATAS_COMMAND, is_last ? 0xFF : 0x00, 0x00, Buffer.from(chunk), this.allowedStatuses);
        if (!this.isSuccess(result)) this.mapProtocolError(result);
        return result;
    }
    async getAppInfo() {
        this._lock();
        try {
            let result = await this.transport.send(0xB0, GET_APP_INFO_COMMAND, 0x00, 0x00, Buffer(0), this.allowedStatuses);
            if (!this.isSuccess(result)) this.mapProtocolError(result);

            result = result.slice(0, result.length - 2);
            let app_name, app_version;
            try {
                let offset = 1;
                let app_name_length = result[offset++];
                app_name = result.slice(offset, offset + app_name_length).toString();
                offset += app_name_length;
                let app_version_length = result[offset++];
                app_version = result.slice(offset, offset + app_version_length).toString();
                return [app_name, app_version];
            }
            catch (error) {
                throw new Error(`Unexpected result from device, parsing error: ${error}`);
            }
        }
        finally {
            this._unlock();
        }
    }

    async getAppConfig() {
        this._lock();
        try {
            let result = await this.transport.send(0xE0, GET_APP_CONFIG_COMMAND, 0x00, 0x00, Buffer(0), this.allowedStatuses);
            if (!this.isSuccess(result)) this.mapProtocolError(result);
            result = result.slice(0, result.length - 2);
            if (result.length !== 6) throw new Error(`Can't parse app config of length ${result.length}`);

            let storage_size = result.readUInt32BE(0, 4);
            let keyboard_type = result[4];
            let press_enter_after_typing = result[5];
            return { storage_size, keyboard_type, press_enter_after_typing };
        }
        finally {
            this._unlock();
        }
    }


    async dump_metadatas() {
        this._lock();
        try {
            let metadatas = Buffer.alloc(0)
            while (metadatas.length < this.storage_size) {
                let result = await this.transport.send(0xE0, DUMP_METADATAS_COMMAND, 0x00, 0x00, Buffer(0), this.allowedStatuses);
                if (!this.isSuccess(result)) this.mapProtocolError(result);
                metadatas = Buffer.concat([metadatas, Buffer.from(result.slice(1, -2))]);
                if (result[0] === 0xFF && metadatas.length < this.storage_size) {
                    throw new Error(`${this.storage_size} bytes requested but only ${metadatas.length} bytes available`);
                }
            }
            return this._toJSON(metadatas);
        }
        finally {
            this._unlock();
        }
    }

    async load_metadatas(JSON_metadatas) {
        this._lock();
        try {
            let metadatas = this._toBytes(JSON_metadatas);
            if (metadatas.length === 0) {
                throw new Error("No data to load");
            }
            for (let i = 0; i < metadatas.length; i += 0xFF) {
                let chunk = metadatas.slice(i, i + 0xFF);
                await this._load_metadatas_chunk(chunk, i + chunk.length === metadatas.length ? true : false)
            }
        }
        finally {
            this._unlock();
        }
    }

}

export default PasswordsManager