interface ESPData {
  device_id: string;
  temperature: number;
  humidity: number;
  free_memory: number;
  uptime: number;
  timestamp: string;
  bluetooth_is_active: boolean;
}