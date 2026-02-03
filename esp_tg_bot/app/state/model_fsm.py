from aiogram.fsm.state import StatesGroup, State

class ModelFSM(StatesGroup):
    choosing = State()