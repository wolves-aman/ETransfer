import {nanoid} from 'nanoid'

class User {
    WsClient

    constructor(client) {
        this.WsClient = client
    }

    sendMsg(msgObj) {
        this.WsClient.send(JSON.stringify(msgObj))
    }
}

class Room {
    ID //房间号
    UserList=[];
    MaxUser=2;

    constructor(roomId, client) {
        this.ID = roomId
        let user = new User(client);
        this.UserList.push(user)
    }

    addUser(client) {
        this.UserList.findIndex(user=>user.WsClient === client)===-1 && this.UserList.push(new User(client));
    }
    removeUser(client){
        this.UserList = this.UserList.filter(user=>user.WsClient !== client)
    }
    sendMsgToOtherUser(client,msgObj){
        this.UserList.forEach(user=>{
            if(user.WsClient !== client){
                user.sendMsg(msgObj)
            }
        })
    }

    sendMsgToAll(msgObj){
        this.UserList.forEach(user=>{
            console.log("user send all",msgObj)
            user.sendMsg(msgObj);
        })
    }

}

const RoomList = {
    rooms: new Map(),
    //创建房间
    createRoom(roomId, client) {
        if (!roomId) {
            roomId = nanoid()
        }
        let room = this.rooms.get(roomId)
        if (room) {
            throw new Error("房间已存在!")
        }
        room = new Room(roomId, client)
        this.rooms.set(roomId, room)
        return room
    },

    //加入房间
    joinRoom(roomId, client) {
        if (!roomId) {
            throw new Error("房间号不能为空!")
        }
        const room = this.rooms.get(roomId)
        if(!room){
            throw new Error("房间不存在!")
        }
        if ( room.UserList.length >= room.MaxUser) {
            throw new Error("房间已满!")
        }
        room.addUser(client)
        return room
    },

    //离开房间
    leaveRoom(roomId, client) {
        const room = this.rooms.get(roomId)
        if(!room){
            return 0
        }
        room.removeUser(client)
        if(room.UserList.length===0){
            console.log("关闭房间",roomId)
            this.rooms.delete(roomId)
        }
        return room.UserList.length
    }
}
export default RoomList
